-- Technical worker loss must not become a terminal business failure.
--
-- The stale reaper still performs its duplicate protection and attempt
-- accounting. This BEFORE trigger only changes its final running -> failed
-- transition back into a delayed, idempotent retry when the error proves that
-- the failure came from a worker timeout/stale lock.

create or replace function public.salonboard_prevent_terminal_timeout_failure()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  if old.status = 'running'
     and new.status = 'failed'
     and new.job_type in ('push_booking', 'cancel_booking', 'push_shifts')
     and (
       coalesce(new.error, '') like '%[JOB_TIMEOUT]%'
       or coalesce(new.error, '') like '%[STALE_LOCK_RETRY_EXHAUSTED]%'
     )
  then
    new.status := 'queued';
    new.attempts := 0;
    new.max_attempts := greatest(new.max_attempts, 3);
    new.run_at := now() + interval '1 minute';
    new.completed_at := null;
    new.locked_at := null;
    new.locked_by := null;
    new.payload := coalesce(new.payload, '{}'::jsonb)
      || jsonb_build_object(
           'preflight_required', true,
           'recovered_from_terminal_timeout', true
         );
    new.error := left(
      coalesce(new.error, '') ||
      ' [TERMINAL_TIMEOUT_REQUEUED] 技術的タイムアウトを失敗確定せず1分後に再処理',
      1000
    );
  end if;
  return new;
end;
$function$;

drop trigger if exists trg_000_prevent_terminal_timeout_failure
  on public.salonboard_sync_jobs;
create trigger trg_000_prevent_terminal_timeout_failure
before update of status
on public.salonboard_sync_jobs
for each row
execute function public.salonboard_prevent_terminal_timeout_failure();

-- Recover terminal timeout rows created before this trigger existed.
update public.salonboard_sync_jobs
   set status = 'queued',
       attempts = 0,
       max_attempts = greatest(max_attempts, 3),
       run_at = now() + interval '1 minute',
       completed_at = null,
       locked_at = null,
       locked_by = null,
       payload = coalesce(payload, '{}'::jsonb)
         || jsonb_build_object(
              'preflight_required', true,
              'recovered_from_terminal_timeout', true
            ),
       error = left(
         coalesce(error, '') ||
         ' [TERMINAL_TIMEOUT_REQUEUED] 技術的タイムアウトを失敗確定せず再処理',
         1000
       ),
       updated_at = now()
 where job_type in ('push_booking', 'cancel_booking', 'push_shifts')
   and status = 'failed'
   and (
     coalesce(error, '') like '%[JOB_TIMEOUT]%'
     or coalesce(error, '') like '%[STALE_LOCK_RETRY_EXHAUSTED]%'
   );
