-- Cloud writes must converge even when SalonBoard presents image auth or the
-- Cloud browser exhausts its retries.  Booking writes already fell back to the
-- shop PC; include the monthly shift write in the same durable route.
create or replace function public.salonboard_force_cloud_failure_fallback()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  should_fallback boolean;
begin
  should_fallback :=
    new.executor = 'playwright_cloud'
    and new.job_type in ('push_booking', 'cancel_booking', 'push_shifts')
    and (
      new.status = 'failed'
      or (
        new.status = 'queued'
        and (
          new.attempts >= new.max_attempts
          or coalesce(new.error, '') like '%[IMAGE_AUTH_REQUIRED]%'
        )
      )
    );

  if not should_fallback then return new; end if;

  if exists (
    select 1
      from public.salonboard_sync_jobs active
     where active.id <> new.id
       and active.status in ('queued', 'running')
       and active.job_type = new.job_type
       and (
         (
           new.job_type in ('push_booking', 'cancel_booking')
           and new.payload ? 'booking_id'
           and active.payload->>'booking_id' is not distinct from new.payload->>'booking_id'
         )
         or (
           new.job_type = 'push_shifts'
           and active.shop_id = new.shop_id
           and active.payload->>'month' is not distinct from new.payload->>'month'
         )
       )
  ) then
    update public.salonboard_sync_jobs
       set status = 'cancelled',
           completed_at = now(),
           locked_at = null,
           locked_by = null,
           error = '[CLOUD_PC_FALLBACK_DEDUPED] 同一対象の処理ジョブが既に存在するため重複ジョブを終了: '
             || coalesce(new.error, '詳細なし')
     where id = new.id;
  else
    update public.salonboard_sync_jobs
       set status = 'queued',
           executor = 'playwright',
           payload = coalesce(payload, '{}'::jsonb) || jsonb_build_object(
             'pc_fallback', true,
             'pc_fallback_at', now(),
             'pc_fallback_from', 'playwright_cloud'
           ),
           attempts = 0,
           max_attempts = greatest(max_attempts, 3),
           run_at = now(),
           completed_at = null,
           locked_at = null,
           locked_by = null,
           error = case
             when coalesce(new.error, '') like '%[IMAGE_AUTH_REQUIRED]%'
               then '[CLOUD_PC_FALLBACK] CloudでSalonBoard画像認証を検知したためPC workerへ即時移管: '
             else '[CLOUD_PC_FALLBACK] Cloud処理が終端失敗したためPC workerへ移管: '
           end || coalesce(new.error, '詳細なし')
     where id = new.id;
  end if;
  return new;
end;
$function$;

drop trigger if exists trg_force_cloud_failure_fallback
  on public.salonboard_sync_jobs;
create trigger trg_force_cloud_failure_fallback
after update of status on public.salonboard_sync_jobs
for each row
when (
  new.executor = 'playwright_cloud'
  and new.job_type in ('push_booking', 'cancel_booking', 'push_shifts')
  and new.status in ('failed', 'queued')
)
execute function public.salonboard_force_cloud_failure_fallback();

-- A cancellation with no reserve ID is safely idempotent only when there has
-- never been a successful SalonBoard push for that booking.  Persist that fact
-- at enqueue time so the worker never has to guess from incomplete names.
create or replace function public.salonboard_enqueue_cancel(
  p_booking_id uuid,
  p_shop_id uuid,
  p_source text,
  p_external_booking_id text,
  p_scheduled_at timestamptz,
  p_staff_external_id text,
  p_staff_name text,
  p_set_pending boolean,
  p_customer_name text,
  p_booking_type text default null,
  p_block_reason text default null,
  p_duration_min integer default null
)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_org_id uuid;
  v_enabled boolean;
  v_push_enabled boolean;
  v_blocked_until timestamptz;
  v_existing int;
  v_btype text := p_booking_type;
  v_breason text := p_block_reason;
  v_dur int := p_duration_min;
  v_never_synced boolean := false;
begin
  if (p_external_booking_id is null or btrim(p_external_booking_id) = '')
     and p_scheduled_at is null then
    return;
  end if;

  select c.organization_id, c.enabled, c.sync_push_enabled, c.blocked_until
    into v_org_id, v_enabled, v_push_enabled, v_blocked_until
    from public.salonboard_credentials c
   where c.shop_id = p_shop_id
   limit 1;

  if v_org_id is null then return; end if;
  if v_enabled is not true then return; end if;
  if v_push_enabled is false then return; end if;
  if v_blocked_until is not null and v_blocked_until > now() then return; end if;

  if v_btype is null then
    select b.booking_type,
           coalesce(v_breason, b.block_reason),
           coalesce(v_dur, b.duration_min)
      into v_btype, v_breason, v_dur
      from public.bookings b
     where b.id = p_booking_id;
  end if;

  v_never_synced :=
    nullif(btrim(coalesce(p_external_booking_id, '')), '') is null
    and not exists (
      select 1
        from public.salonboard_sync_jobs pushed
       where pushed.job_type = 'push_booking'
         and pushed.status = 'succeeded'
         and pushed.payload->>'booking_id' = p_booking_id::text
    );

  select count(*)
    into v_existing
    from public.salonboard_sync_jobs j
   where j.shop_id = p_shop_id
     and j.job_type = 'cancel_booking'
     and j.status in ('queued', 'running')
     and j.payload->>'booking_id' = p_booking_id::text;
  if v_existing > 0 then return; end if;

  insert into public.salonboard_sync_jobs
    (shop_id, organization_id, job_type, priority, payload)
  values (
    p_shop_id, v_org_id, 'cancel_booking', 10,
    jsonb_build_object(
      'booking_id', p_booking_id,
      'action', 'cancel',
      'assume_absent_if_never_synced', v_never_synced,
      'snapshot', jsonb_build_object(
        'external_booking_id', p_external_booking_id,
        'scheduled_at', p_scheduled_at,
        'salonboard_staff_external_id', p_staff_external_id,
        'salonboard_staff_name', p_staff_name,
        'customer_name', p_customer_name,
        'booking_type', v_btype,
        'block_reason', v_breason,
        'duration_min', v_dur,
        'assume_absent_if_never_synced', v_never_synced
      )
    )
  );

  if p_set_pending then
    update public.bookings
       set salonboard_sync_status = 'pending_cancel',
           salonboard_last_push_error = null
     where id = p_booking_id;
  end if;
end;
$function$;

-- Backfill only cancel jobs whose original push is provably terminal without
-- ever succeeding.  This includes the current Namba incident and is idempotent.
update public.salonboard_sync_jobs cancelled
   set payload = coalesce(cancelled.payload, '{}'::jsonb)
     || jsonb_build_object('assume_absent_if_never_synced', true)
 where cancelled.job_type = 'cancel_booking'
   and nullif(btrim(coalesce(cancelled.payload#>>'{snapshot,external_booking_id}', '')), '') is null
   and cancelled.payload ? 'booking_id'
   and not exists (
     select 1
       from public.salonboard_sync_jobs pushed
      where pushed.job_type = 'push_booking'
        and pushed.status = 'succeeded'
        and pushed.payload->>'booking_id' = cancelled.payload->>'booking_id'
   );
