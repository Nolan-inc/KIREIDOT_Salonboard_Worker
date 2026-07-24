-- KIREIDOT -> SalonBoard operations are Cloud-authoritative.  The only
-- operation that may intentionally use the shop PC is photo/style reflection
-- (push_photo_gallery), because that flow depends on local image handling.
--
-- Older migrations moved terminal Cloud booking/shift failures to the PC.
-- That made old rows disappear from the newest-job view and allowed the
-- desktop worker to requeue transient SalonBoard errors indefinitely.  Remove
-- that route and enforce the executor invariant at the database boundary.

drop trigger if exists trg_force_cloud_failure_fallback
  on public.salonboard_sync_jobs;

create or replace function public.salonboard_force_cloud_failure_fallback()
returns trigger
language plpgsql
security definer
set search_path = public
as $function$
begin
  -- Compatibility no-op. Cloud jobs stay Cloud even after terminal failure;
  -- retry/recovery is performed by Cloud, never by a shop PC.
  return new;
end;
$function$;

revoke all on function public.salonboard_force_cloud_failure_fallback()
  from public, anon, authenticated;

drop trigger if exists trg_preserve_pc_fallback_executor
  on public.salonboard_sync_jobs;

create or replace function public.salonboard_enforce_cloud_executor()
returns trigger
language plpgsql
security definer
set search_path = public
as $function$
begin
  if new.job_type is distinct from 'push_photo_gallery' then
    new.executor := 'playwright_cloud';
    new.payload := coalesce(new.payload, '{}'::jsonb)
      - 'pc_fallback'
      - 'pc_fallback_at'
      - 'pc_fallback_from';
  end if;
  return new;
end;
$function$;

revoke all on function public.salonboard_enforce_cloud_executor()
  from public, anon, authenticated;

drop trigger if exists trg_enforce_cloud_executor
  on public.salonboard_sync_jobs;
create trigger trg_enforce_cloud_executor
before insert or update
on public.salonboard_sync_jobs
for each row
execute function public.salonboard_enforce_cloud_executor();

-- Recover any still-active desktop work.  Completed historical rows are left
-- untouched for auditability.
update public.salonboard_sync_jobs
set executor = 'playwright_cloud',
    payload = coalesce(payload, '{}'::jsonb)
      - 'pc_fallback'
      - 'pc_fallback_at'
      - 'pc_fallback_from',
    status = 'queued',
    attempts = 0,
    run_at = now(),
    locked_at = null,
    locked_by = null,
    completed_at = null,
    error = case
      when coalesce(error, '') like '%[CLOUD_PC_FALLBACK]%' then null
      else error
    end,
    updated_at = now()
where executor = 'playwright'
  and job_type <> 'push_photo_gallery'
  and status in ('queued', 'running', 'retryable_failed');
