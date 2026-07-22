-- 2026-07-23 incident prevention:
-- 1. Do not enqueue completed or past-day booking history as SalonBoard writes.
-- 2. Move exhausted Cloud booking writes to the PC worker even when the callback
--    first records retryable_failed instead of failed/queued.

create or replace function public.bookings_autoenqueue_salonboard_update()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_org_id uuid;
  v_enabled boolean;
  v_push_enabled boolean;
  v_blocked_until timestamptz;
  v_write_cooldown_until timestamptz;
  v_run_at timestamptz;
  v_existing int;
  v_has_external_id boolean;
begin
  if pg_trigger_depth() > 1 then return new; end if;
  if new.source = 'salonboard' then return new; end if;

  if new.scheduled_at is not distinct from old.scheduled_at
     and new.duration_min is not distinct from old.duration_min
     and new.staff_id is not distinct from old.staff_id
     and new.menu_id is not distinct from old.menu_id
     and new.resource_id is not distinct from old.resource_id
     and new.customer_id is not distinct from old.customer_id
     and new.customer_name is not distinct from old.customer_name
     and new.notes is not distinct from old.notes
     and new.coupon_name is not distinct from old.coupon_name
     and new.booking_type is not distinct from old.booking_type
     and new.block_reason is not distinct from old.block_reason then
    return new;
  end if;

  if new.status in ('cancelled', 'no_show', 'completed') then return new; end if;
  if new.scheduled_at is null
     or (new.scheduled_at at time zone 'Asia/Tokyo')::date
        < (now() at time zone 'Asia/Tokyo')::date then
    return new;
  end if;

  select c.organization_id, c.enabled, c.sync_push_enabled,
         c.blocked_until, c.write_cooldown_until
    into v_org_id, v_enabled, v_push_enabled,
         v_blocked_until, v_write_cooldown_until
    from public.salonboard_credentials c
   where c.shop_id = new.shop_id
   limit 1;
  if v_org_id is null or v_enabled is not true or v_push_enabled is false then return new; end if;

  v_run_at := greatest(
    now(),
    coalesce(v_blocked_until, now()),
    coalesce(v_write_cooldown_until, now())
  );
  v_has_external_id := coalesce(nullif(btrim(coalesce(new.external_booking_id, '')), ''), null) is not null;

  select count(*) into v_existing
    from public.salonboard_sync_jobs j
   where j.shop_id = new.shop_id
     and j.job_type = 'push_booking'
     and j.status in ('queued', 'scheduled', 'retryable_failed')
     and j.payload->>'booking_id' = new.id::text;
  if v_existing > 0 then return new; end if;

  insert into public.salonboard_sync_jobs
    (shop_id, organization_id, job_type, priority, run_at, max_attempts, payload)
  values (
    new.shop_id, v_org_id, 'push_booking',
    case when v_has_external_id then 2 else 100 end,
    v_run_at,
    case when v_has_external_id then 3 else 1 end,
    case when v_has_external_id
      then jsonb_build_object('booking_id', new.id, 'action', 'update')
      else jsonb_build_object('booking_id', new.id, 'action', 'create', 'preflight_required', true)
    end
  );

  update public.bookings
     set salonboard_sync_status = 'pending_push',
         salonboard_last_push_error = null
   where id = new.id;
  return new;
exception when others then
  return new;
end;
$function$;

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
    and new.job_type in ('push_booking', 'cancel_booking')
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
       and active.job_type = new.job_type
       and active.payload->>'booking_id' is not distinct from new.payload->>'booking_id'
       and new.payload ? 'booking_id'
       and active.status in ('queued', 'running')
  ) then
    update public.salonboard_sync_jobs
       set status = 'cancelled',
           completed_at = now(),
           locked_at = null,
           locked_by = null,
           error = '[CLOUD_PC_FALLBACK_DEDUPED] 同じ予約の処理ジョブが既に存在するため重複ジョブを終了: '
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

drop trigger if exists trg_force_cloud_failure_fallback on public.salonboard_sync_jobs;
create trigger trg_force_cloud_failure_fallback
after update of status on public.salonboard_sync_jobs
for each row
when (
  new.executor = 'playwright_cloud'
  and new.job_type in ('push_booking', 'cancel_booking')
  and new.status in ('failed', 'queued')
)
execute function public.salonboard_force_cloud_failure_fallback();

-- The callback replaces error with the latest PC attempt error.  Therefore the
-- fallback marker must not live only in error text: the legacy stale-PC rescue
-- would otherwise mistake it for a normal desktop job and send it back to Cloud.
create or replace function public.salonboard_reroute_stale_pc_writes()
returns integer
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_n integer := 0;
begin
  update public.salonboard_sync_jobs j
     set executor = 'playwright_cloud',
         updated_at = now()
    from public.salonboard_credentials c
   where c.shop_id = j.shop_id
     and c.enabled = true
     and j.status = 'queued'
     and j.executor = 'playwright'
     and j.job_type in (
       'push_booking', 'cancel_booking', 'push_blog', 'delete_blog',
       'push_review_reply', 'push_shifts', 'push_staff', 'push_menu',
       'push_coupon', 'push_equipment', 'push_shift_patterns',
       'push_acceptance', 'fetch_shift_patterns'
     )
     and j.created_at < now() - interval '45 seconds'
     and coalesce(j.error, '') not like '%[CLOUD_PC_FALLBACK]%'
     and coalesce(j.payload->>'pc_fallback', 'false') <> 'true';
  get diagnostics v_n = row_count;
  return v_n;
end;
$function$;

revoke all on function public.salonboard_reroute_stale_pc_writes() from public;

-- Defense in depth: keep an intentional fallback on PC even if an older API
-- or maintenance function attempts to change only the executor back to Cloud.
create or replace function public.salonboard_preserve_pc_fallback_executor()
returns trigger
language plpgsql
security definer
set search_path = public
as $function$
begin
  if old.executor = 'playwright'
     and coalesce(old.payload->>'pc_fallback', 'false') = 'true'
     and new.executor = 'playwright_cloud'
  then
    new.executor := 'playwright';
    new.payload := coalesce(new.payload, old.payload, '{}'::jsonb)
      || jsonb_build_object('pc_fallback', true);
  end if;
  return new;
end;
$function$;

drop trigger if exists trg_preserve_pc_fallback_executor
  on public.salonboard_sync_jobs;
create trigger trg_preserve_pc_fallback_executor
before update of executor on public.salonboard_sync_jobs
for each row
execute function public.salonboard_preserve_pc_fallback_executor();

-- Backfill the active incident job that was moved before the durable payload
-- marker existed.  The predicate is intentionally narrow and idempotent.
update public.salonboard_sync_jobs
   set payload = coalesce(payload, '{}'::jsonb) || jsonb_build_object(
         'pc_fallback', true,
         'pc_fallback_at', now(),
         'pc_fallback_from', 'playwright_cloud'
       )
 where id = '9036b44b-0c40-4ebc-934a-a60b0e5c8c27'::uuid
   and executor = 'playwright'
   and status in ('queued', 'running');
