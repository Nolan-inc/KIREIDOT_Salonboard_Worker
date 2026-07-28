-- Booking writes need the current KIREIDOT status at execution time.
-- SalonBoard no longer exposes an editable form after checkout/completion, so retrying
-- an update forever only creates noise and cannot converge.

create or replace function public.salonboard_enrich_job_booking_status()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_booking_status text;
  v_booking_id uuid;
begin
  if new.job_type <> 'push_booking'
     or coalesce(new.payload->>'booking_id', '') !~
        '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
  then
    return new;
  end if;

  v_booking_id := (new.payload->>'booking_id')::uuid;
  select b.status::text
    into v_booking_status
    from public.bookings b
   where b.id = v_booking_id;

  if v_booking_status is not null then
    new.payload := jsonb_set(
      coalesce(new.payload, '{}'::jsonb),
      '{booking_status}',
      to_jsonb(v_booking_status),
      true
    );
  end if;

  return new;
end;
$$;

revoke all on function public.salonboard_enrich_job_booking_status() from public;

drop trigger if exists trg_enrich_salonboard_job_booking_status
  on public.salonboard_sync_jobs;
create trigger trg_enrich_salonboard_job_booking_status
before insert or update of payload, status
on public.salonboard_sync_jobs
for each row
execute function public.salonboard_enrich_job_booking_status();

-- Enrich existing unresolved jobs immediately.
update public.salonboard_sync_jobs j
   set payload = jsonb_set(
         coalesce(j.payload, '{}'::jsonb),
         '{booking_status}',
         to_jsonb(b.status::text),
         true
       ),
       updated_at = j.updated_at
  from public.bookings b
 where j.job_type = 'push_booking'
   and j.payload->>'booking_id' = b.id::text
   and j.status in (
     'queued', 'running', 'retryable_failed', 'failed', 'manual_required'
   );

-- If a newer active job already covers the same booking, retire the legacy duplicate
-- instead of violating the one-queued-job-per-booking guard.
update public.salonboard_sync_jobs j
   set status = 'cancelled',
       completed_at = now(),
       locked_at = null,
       locked_by = null,
       error = concat_ws(
         ' ',
         nullif(j.error, ''),
         '[RECOVER_LEGACY_PC_DUPLICATE] newer active Cloud job already covers this booking'
       ),
       result = coalesce(j.result, '{}'::jsonb) || jsonb_build_object(
         'recovery', 'duplicate_retired',
         'recovered_at', now()
       ),
       updated_at = now()
 where j.executor = 'playwright'
   and j.job_type in ('push_booking', 'cancel_booking')
   and j.status in ('queued', 'retryable_failed', 'failed', 'manual_required')
   and j.updated_at >= timestamptz '2026-07-28 00:00:00+00'
   and exists (
     select 1
       from public.salonboard_sync_jobs active
      where active.id <> j.id
        and active.job_type = j.job_type
        and active.payload->>'booking_id' = j.payload->>'booking_id'
        and active.status in ('queued', 'running', 'retryable_failed')
   );

-- Multiple historical failed desktop rows can exist for the same booking. Keep only
-- the newest candidate before converting status to queued (the unique queued index
-- cannot arbitrate rows changed by one UPDATE statement).
with ranked_legacy as (
  select j.id,
         row_number() over (
           partition by j.job_type, j.payload->>'booking_id'
           order by j.updated_at desc, j.created_at desc, j.id desc
         ) as rn
    from public.salonboard_sync_jobs j
   where j.executor = 'playwright'
     and j.job_type in ('push_booking', 'cancel_booking')
     and j.status in ('queued', 'retryable_failed', 'failed', 'manual_required')
     and j.updated_at >= timestamptz '2026-07-28 00:00:00+00'
     and coalesce(j.payload->>'booking_id', '') <> ''
)
update public.salonboard_sync_jobs j
   set status = 'cancelled',
       completed_at = now(),
       locked_at = null,
       locked_by = null,
       error = concat_ws(
         ' ',
         nullif(j.error, ''),
         '[RECOVER_LEGACY_PC_DUPLICATE] older duplicate retired before Cloud recovery'
       ),
       result = coalesce(j.result, '{}'::jsonb) || jsonb_build_object(
         'recovery', 'older_duplicate_retired',
         'recovered_at', now()
       ),
       updated_at = now()
  from ranked_legacy r
 where j.id = r.id
   and r.rn > 1;

-- Legacy PC fallbacks created before the compatible-worker gate must not stay failed
-- on an old desktop build. Put the remaining non-running booking/shift writes on Cloud.
update public.salonboard_sync_jobs j
   set status = 'queued',
       executor = 'playwright_cloud',
       run_at = now(),
       attempts = 0,
       locked_at = null,
       locked_by = null,
       started_at = null,
       completed_at = null,
       error = concat_ws(
         ' ',
         nullif(j.error, ''),
         '[RECOVER_LEGACY_PC_TO_CLOUD] compatible PC unavailable; retry on current Cloud worker'
       ),
       payload = (
         coalesce(j.payload, '{}'::jsonb)
         - 'pc_fallback'
         - 'pc_fallback_at'
         - 'pc_fallback_reason'
       ) || jsonb_build_object(
         'preflight_required', true,
         'cloud_recovered_at', now()
       ),
       updated_at = now()
 where j.executor = 'playwright'
   and j.job_type in (
     'push_booking', 'cancel_booking', 'push_shifts', 'push_shift_patterns'
   )
   and j.status in ('queued', 'retryable_failed', 'failed', 'manual_required')
   and j.updated_at >= timestamptz '2026-07-28 00:00:00+00'
   and not exists (
     select 1
       from public.salonboard_sync_jobs active
      where active.id <> j.id
        and active.job_type = j.job_type
        and active.payload->>'booking_id' = j.payload->>'booking_id'
        and active.status in ('queued', 'running', 'retryable_failed')
   );
