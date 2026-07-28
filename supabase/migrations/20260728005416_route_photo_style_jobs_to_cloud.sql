-- Photo/style reflection no longer depends on the desktop worker.  The Cloud
-- worker downloads the public Storage object before posting the multipart
-- form, so keeping this job type on PC only exposes it to stale desktop
-- versions, missing Chrome-extension frames, and group-salon selection bugs.

create or replace function public.salonboard_enforce_cloud_executor()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  -- Booking/cancel/shift writes may use the guarded compatible-PC fallback
  -- installed by 20260727171841.  All normal inserts/updates, including
  -- push_photo_gallery, remain Cloud-authoritative.
  if coalesce(new.payload->>'pc_fallback', 'false') = 'true'
     and new.executor = 'playwright'
     and new.job_type in ('push_booking', 'cancel_booking', 'push_shifts') then
    return new;
  end if;

  new.executor := 'playwright_cloud';
  new.payload := coalesce(new.payload, '{}'::jsonb)
    - 'pc_fallback'
    - 'pc_fallback_at'
    - 'pc_fallback_from';
  return new;
end;
$function$;

revoke all on function public.salonboard_enforce_cloud_executor()
  from public, anon, authenticated;

-- Recover only unfinished photo/style work here.  Terminal historical rows
-- remain untouched for auditability and are explicitly retried after deploy.
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
    updated_at = now()
where job_type = 'push_photo_gallery'
  and status in ('queued', 'running', 'retryable_failed');
