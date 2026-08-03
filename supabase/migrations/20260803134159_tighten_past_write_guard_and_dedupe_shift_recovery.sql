-- Block booking/cancellation writes once the appointment start is more than
-- 30 minutes in the past. A date-only guard still allowed stale same-day jobs
-- to be replayed late at night.
create or replace function public.salonboard_guard_elapsed_write()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_scheduled_at timestamptz;
begin
  if new.job_type not in ('push_booking', 'cancel_booking')
     or new.status in ('succeeded', 'cancelled')
     or coalesce(new.payload->>'scheduled_at', '') = ''
     or coalesce(new.payload->>'allow_past_write', 'false') = 'true'
  then
    return new;
  end if;

  begin
    v_scheduled_at := (new.payload->>'scheduled_at')::timestamptz;
  exception when others then
    return new;
  end;

  if v_scheduled_at < now() - interval '30 minutes' then
    new.status := 'cancelled';
    new.executor := case when new.executor = 'playwright' then 'playwright_cloud' else new.executor end;
    new.payload := (
      coalesce(new.payload, '{}'::jsonb)
        - 'pc_fallback' - 'pc_fallback_at' - 'pc_fallback_from' - 'pc_fallback_reason'
    ) || jsonb_build_object(
      'audit_exclude_kpi', true,
      'audit_exclude_reason', 'elapsed_booking_write_blocked',
      'audit_excluded_at', now()
    );
    new.completed_at := coalesce(new.completed_at, now());
    new.locked_at := null;
    new.locked_by := null;
    new.error := left(
      '[ELAPSED_BOOKING_WRITE_BLOCKED] 開始時刻を30分以上過ぎた予約はSalonBoardへ再投入しません: '
        || coalesce(new.error, '詳細なし'),
      1000
    );
    new.updated_at := now();
  end if;

  return new;
end;
$function$;

revoke all on function public.salonboard_guard_elapsed_write()
  from public, anon, authenticated;

drop trigger if exists trg_000_salonboard_guard_elapsed_write
  on public.salonboard_sync_jobs;
create trigger trg_000_salonboard_guard_elapsed_write
before insert or update
on public.salonboard_sync_jobs
for each row
execute function public.salonboard_guard_elapsed_write();

-- Apply the elapsed-time guard to existing incident retries.
update public.salonboard_sync_jobs
set updated_at = now()
where job_type in ('push_booking', 'cancel_booking')
  and status in ('queued', 'running', 'retryable_failed', 'failed', 'manual_required')
  and coalesce(payload->>'scheduled_at', '') <> ''
  and (payload->>'scheduled_at')::timestamptz < now() - interval '30 minutes'
  and coalesce(payload->>'allow_past_write', 'false') <> 'true';

-- A shift reflection is a full-state operation. Keep only the newest active
-- recovery per shop; older copies would repeat the same external write.
with ranked_shift_retries as (
  select id,
         row_number() over (
           partition by shop_id
           order by created_at desc, id desc
         ) as retry_rank
  from public.salonboard_sync_jobs
  where job_type = 'push_shifts'
    and status in ('queued', 'running', 'retryable_failed')
    and payload->>'pc_fallback_blocked_reason' = 'shop_affinity_not_verifiable'
)
update public.salonboard_sync_jobs j
set status = 'cancelled',
    payload = coalesce(j.payload, '{}'::jsonb) || jsonb_build_object(
      'audit_exclude_kpi', true,
      'audit_exclude_reason', 'duplicate_shift_recovery_superseded',
      'audit_excluded_at', now()
    ),
    completed_at = coalesce(j.completed_at, now()),
    locked_at = null,
    locked_by = null,
    error = '[SHIFT_RECOVERY_SUPERSEDED] 同一店舗の最新シフト反映ジョブへ統合しました',
    updated_at = now()
from ranked_shift_retries ranked
where ranked.id = j.id
  and ranked.retry_rank > 1;
