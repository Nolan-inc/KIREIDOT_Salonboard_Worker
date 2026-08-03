-- Reliability guard for the 2026-08-03 incident.
--
-- The old fallback gate checked whether any compatible desktop heartbeat was
-- alive. The heartbeat has no shop affinity, so a PC for another company could
-- make the gate true. Jobs then moved to a PC that could not claim their shop
-- and failed after ten minutes with PC_FALLBACK_TIMEOUT.
--
-- Until heartbeats can be joined to salonboard_sync_device_shops, booking,
-- cancellation and shift recovery stays on the two Cloud lanes. The same guard
-- stops recovery writes for appointments whose local calendar day is over.

create or replace function public.salonboard_guard_write_routing()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_scheduled_at timestamptz;
  v_canonical_job_id uuid;
begin
  if new.job_type in ('push_booking', 'cancel_booking')
     and coalesce(new.payload->>'scheduled_at', '') <> ''
  then
    begin
      v_scheduled_at := (new.payload->>'scheduled_at')::timestamptz;
    exception when others then
      v_scheduled_at := null;
    end;

    if v_scheduled_at is not null
       and (v_scheduled_at at time zone 'Asia/Tokyo')::date
           < (now() at time zone 'Asia/Tokyo')::date
       and new.status not in ('succeeded', 'cancelled')
       and coalesce(new.payload->>'allow_past_write', 'false') <> 'true'
    then
      new.status := 'cancelled';
      new.executor := case
        when new.executor = 'playwright' then 'playwright_cloud'
        else new.executor
      end;
      new.payload := (
        coalesce(new.payload, '{}'::jsonb)
          - 'pc_fallback'
          - 'pc_fallback_at'
          - 'pc_fallback_from'
          - 'pc_fallback_reason'
      ) || jsonb_build_object(
        'audit_exclude_kpi', true,
        'audit_exclude_reason', 'past_booking_write_blocked',
        'audit_excluded_at', now()
      );
      new.completed_at := coalesce(new.completed_at, now());
      new.locked_at := null;
      new.locked_by := null;
      new.error := left(
        '[PAST_BOOKING_WRITE_BLOCKED] 過去日の予約はSalonBoardへ再投入しません: '
          || coalesce(new.error, '詳細なし'),
        1000
      );
      new.updated_at := now();
      return new;
    end if;
  end if;

  -- A global PC heartbeat does not prove that this shop can be claimed.
  if new.job_type in ('push_booking', 'cancel_booking', 'push_shifts')
     and new.executor = 'playwright'
     and coalesce(new.payload->>'pc_fallback', 'false') = 'true'
     and new.status not in ('succeeded', 'cancelled')
  then
    -- A Cloud retry may already have been created for the same booking while
    -- the stale PC fallback row was waiting. Keep the canonical job and close
    -- the duplicate instead of violating the one-queued-job invariant.
    if new.job_type in ('push_booking', 'cancel_booking')
       and coalesce(new.payload->>'booking_id', '') <> ''
    then
      select j.id
      into v_canonical_job_id
      from public.salonboard_sync_jobs j
      where j.id <> new.id
        and j.job_type = new.job_type
        and j.payload->>'booking_id' = new.payload->>'booking_id'
        and j.status in ('queued', 'running', 'retryable_failed')
      order by
        case when j.executor = 'playwright_cloud' then 0 else 1 end,
        j.created_at asc
      limit 1;
    end if;

    if v_canonical_job_id is not null then
      new.status := 'cancelled';
      new.executor := 'playwright_cloud';
      new.payload := (
        coalesce(new.payload, '{}'::jsonb)
          - 'pc_fallback'
          - 'pc_fallback_at'
          - 'pc_fallback_from'
          - 'pc_fallback_reason'
      ) || jsonb_build_object(
        'audit_exclude_kpi', true,
        'audit_exclude_reason', 'duplicate_pc_fallback_superseded',
        'canonical_job_id', v_canonical_job_id,
        'audit_excluded_at', now()
      );
      new.completed_at := coalesce(new.completed_at, now());
      new.locked_at := null;
      new.locked_by := null;
      new.error := '[PC_FALLBACK_SUPERSEDED] 正規Cloudジョブへ統合: ' || v_canonical_job_id::text;
      new.updated_at := now();
      return new;
    end if;

    new.status := 'queued';
    new.executor := 'playwright_cloud';
    new.payload := (
      coalesce(new.payload, '{}'::jsonb)
        - 'pc_fallback'
        - 'pc_fallback_at'
        - 'pc_fallback_from'
        - 'pc_fallback_reason'
    ) || jsonb_build_object(
      'pc_fallback_blocked_reason', 'shop_affinity_not_verifiable',
      'cloud_retry_after_pc_gate_at', now(),
      'preflight_required', true
    );
    new.attempts := 0;
    new.max_attempts := greatest(new.max_attempts, 3);
    new.run_at := now() + interval '1 minute';
    new.completed_at := null;
    new.locked_at := null;
    new.locked_by := null;
    new.error := left(
      '[CLOUD_RETRY_PC_AFFINITY_UNKNOWN] 対象店舗をclaim可能なPCを確認できないためCloudで再試行します: '
        || regexp_replace(
          coalesce(new.error, '詳細なし'),
          '^\[(CLOUD_PC_FALLBACK|CLOUD_RETRY_NO_COMPATIBLE_PC)\][^:]*:\s*',
          ''
        ),
      1000
    );
    new.updated_at := now();
  end if;

  return new;
end;
$function$;

revoke all on function public.salonboard_guard_write_routing()
  from public, anon, authenticated;

drop trigger if exists trg_00_salonboard_guard_write_routing
  on public.salonboard_sync_jobs;
create trigger trg_00_salonboard_guard_write_routing
before insert or update
on public.salonboard_sync_jobs
for each row
execute function public.salonboard_guard_write_routing();

-- The old trigger intentionally forced PC fallback rows to stay on PC. That is
-- unsafe without shop affinity and would undo the guard above.
drop trigger if exists trg_preserve_pc_fallback_executor
  on public.salonboard_sync_jobs;

-- Close stale PC rows when a later Cloud execution already completed the same
-- booking. Replaying these rows would be redundant and can violate the unique
-- queued-job constraint.
update public.salonboard_sync_jobs j
set status = 'cancelled',
    payload = coalesce(j.payload, '{}'::jsonb) || jsonb_build_object(
      'audit_exclude_kpi', true,
      'audit_exclude_reason', 'completed_cloud_job_supersedes_pc_fallback',
      'audit_excluded_at', now()
    ),
    completed_at = coalesce(j.completed_at, now()),
    locked_at = null,
    locked_by = null,
    error = '[PC_FALLBACK_SUPERSEDED] 同一予約のCloud処理が完了済みです',
    updated_at = now()
where j.executor = 'playwright'
  and coalesce(j.payload->>'pc_fallback', 'false') = 'true'
  and j.status in ('queued', 'failed', 'retryable_failed')
  and coalesce(j.payload->>'booking_id', '') <> ''
  and exists (
    select 1
    from public.salonboard_sync_jobs done
    where done.id <> j.id
      and done.job_type = j.job_type
      and done.payload->>'booking_id' = j.payload->>'booking_id'
      and done.status = 'succeeded'
      and done.completed_at >= j.created_at
  );

-- If several failed PC rows exist for one booking, only the newest row may be
-- retried. Older rows are historical duplicates.
with ranked_pc_fallbacks as (
  select j.id,
         row_number() over (
           partition by j.job_type, j.payload->>'booking_id'
           order by j.created_at desc, j.id desc
         ) as retry_rank
  from public.salonboard_sync_jobs j
  where j.executor = 'playwright'
    and coalesce(j.payload->>'pc_fallback', 'false') = 'true'
    and j.status in ('queued', 'failed', 'retryable_failed')
    and coalesce(j.payload->>'booking_id', '') <> ''
)
update public.salonboard_sync_jobs j
set status = 'cancelled',
    payload = coalesce(j.payload, '{}'::jsonb) || jsonb_build_object(
      'audit_exclude_kpi', true,
      'audit_exclude_reason', 'duplicate_pc_fallback_superseded',
      'audit_excluded_at', now()
    ),
    completed_at = coalesce(j.completed_at, now()),
    locked_at = null,
    locked_by = null,
    error = '[PC_FALLBACK_SUPERSEDED] 新しい同一予約ジョブへ統合しました',
    updated_at = now()
from ranked_pc_fallbacks ranked
where ranked.id = j.id
  and ranked.retry_rank > 1;

-- Past writes cannot produce a useful external change anymore. Retain them as
-- auditable cancellations outside the reliability KPI.
update public.salonboard_sync_jobs j
set status = 'cancelled',
    executor = case when j.executor = 'playwright' then 'playwright_cloud' else j.executor end,
    payload = (
      coalesce(j.payload, '{}'::jsonb)
        - 'pc_fallback'
        - 'pc_fallback_at'
        - 'pc_fallback_from'
        - 'pc_fallback_reason'
    ) || jsonb_build_object(
      'audit_exclude_kpi', true,
      'audit_exclude_reason', 'past_booking_write_blocked',
      'audit_excluded_at', now()
    ),
    completed_at = coalesce(j.completed_at, now()),
    locked_at = null,
    locked_by = null,
    error = left(
      '[PAST_BOOKING_WRITE_BLOCKED] 過去日の予約はSalonBoardへ再投入しません: '
        || coalesce(j.error, '詳細なし'),
      1000
    ),
    updated_at = now()
where j.job_type in ('push_booking', 'cancel_booking')
  and coalesce(j.payload->>'scheduled_at', '') <> ''
  and ((j.payload->>'scheduled_at')::timestamptz at time zone 'Asia/Tokyo')::date
      < (now() at time zone 'Asia/Tokyo')::date
  and j.status in ('queued', 'running', 'retryable_failed', 'failed', 'manual_required')
  and coalesce(j.payload->>'allow_past_write', 'false') <> 'true';

-- Existing future PC fallbacks are actionable. Return them to Cloud; the guard
-- guarantees the global heartbeat cannot misroute them back to PC.
update public.salonboard_sync_jobs j
set status = 'queued',
    executor = 'playwright_cloud',
    payload = (
      coalesce(j.payload, '{}'::jsonb)
        - 'pc_fallback'
        - 'pc_fallback_at'
        - 'pc_fallback_from'
        - 'pc_fallback_reason'
    ) || jsonb_build_object(
      'pc_fallback_blocked_reason', 'shop_affinity_not_verifiable',
      'cloud_retry_after_pc_gate_at', now(),
      'preflight_required', true
    ),
    attempts = 0,
    max_attempts = greatest(j.max_attempts, 3),
    run_at = now() + interval '1 minute',
    completed_at = null,
    locked_at = null,
    locked_by = null,
    error = '[CLOUD_RETRY_PC_AFFINITY_UNKNOWN] 店舗PCのshop affinityを確認できないためCloudで再試行します',
    updated_at = now()
where j.job_type in ('push_booking', 'cancel_booking', 'push_shifts')
  and j.executor = 'playwright'
  and coalesce(j.payload->>'pc_fallback', 'false') = 'true'
  and j.status in ('queued', 'failed', 'retryable_failed');

-- Capacity and availability conflicts remain visible for operator action but
-- do not measure automation reliability: retries cannot create an SB photo
-- slot or make a fully occupied equipment selectable.
update public.salonboard_sync_jobs j
set payload = coalesce(j.payload, '{}'::jsonb) || jsonb_build_object(
      'audit_exclude_kpi', true,
      'audit_exclude_reason', case
        when coalesce(j.error, '') like '%フォトギャラリーの空き枠が見つかりません%'
          then 'salonboard_photo_capacity'
        else 'salonboard_equipment_unavailable'
      end,
      'audit_excluded_at', now()
    ),
    updated_at = now()
where j.status in ('failed', 'manual_required')
  and (
    coalesce(j.error, '') like '%フォトギャラリーの空き枠が見つかりません%'
    or coalesce(j.error, '') like '%KDの設備%SalonBoardで選択できません%'
  );

-- Browser termination before opening a registration form is transient and is
-- safe to retry because push_booking preflight is idempotent.
update public.salonboard_sync_jobs j
set status = 'queued',
    executor = 'playwright_cloud',
    payload = coalesce(j.payload, '{}'::jsonb) || jsonb_build_object(
      'preflight_required', true,
      'incident_retry_20260803', true
    ),
    attempts = 0,
    run_at = now() + interval '1 minute',
    completed_at = null,
    locked_at = null,
    locked_by = null,
    error = '[INCIDENT_RETRY_20260803] ブラウザ終了による一時失敗をCloudで再試行します',
    updated_at = now()
where j.status = 'failed'
  and j.job_type = 'push_booking'
  and coalesce(j.error, '') like '%Target page, context or browser has been closed%'
  and coalesce(j.payload->>'scheduled_at', '') <> ''
  and (j.payload->>'scheduled_at')::timestamptz > now();
