-- The operator explicitly wants a booking write that exhausts Cloud retries
-- to run on the shop PC.  A previous "Cloud-only" compatibility migration
-- replaced this function with a no-op, while the notification text still said
-- that the job had moved to PC.  Restore the actual transition and persist it
-- in payload so the executor-normalization trigger cannot route it back.

create or replace function public.salonboard_force_cloud_failure_fallback()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_should_fallback boolean;
  v_error text;
begin
  v_should_fallback :=
    new.executor = 'playwright_cloud'
    and new.job_type in ('push_booking', 'cancel_booking', 'push_shifts')
    and (
      new.status = 'failed'
      or (
        new.status = 'queued'
        and (
          old.attempts >= greatest(old.max_attempts, 3)
          or (
            new.attempts = 0
            and coalesce(new.error, '') ~
              'KPCL017V01|SB_SERVER_ERROR|JOB_TIMEOUT|STALE_LOCK_RETRY_EXHAUSTED'
          )
        )
      )
    );

  if not v_should_fallback then
    return new;
  end if;

  v_error := regexp_replace(
    coalesce(new.error, 'Cloud処理が完了しませんでした'),
    '^\[CLOUD_PC_FALLBACK\][^:]*:\s*',
    ''
  );
  v_error := replace(
    replace(
      v_error,
      '最新情報からCloudで全工程を再試行します。',
      '店舗PCで全工程を再試行します。'
    ),
    '同じCloudで全工程を自動再試行します',
    '店舗PCで全工程を再試行します'
  );

  update public.salonboard_sync_jobs
     set status = 'queued',
         executor = 'playwright',
         payload = coalesce(payload, '{}'::jsonb) || jsonb_build_object(
           'pc_fallback', true,
           'pc_fallback_at', now(),
           'pc_fallback_from', 'playwright_cloud',
           'pc_fallback_reason', 'cloud_retries_exhausted',
           'preflight_required', true
         ),
         attempts = 0,
         max_attempts = greatest(max_attempts, 3),
         run_at = now(),
         completed_at = null,
         locked_at = null,
         locked_by = null,
         error = left(
           '[CLOUD_PC_FALLBACK] Cloudで3回完了できなかったため店舗PCで再実行します: '
             || v_error,
           1000
         ),
         updated_at = now()
   where id = new.id;

  return new;
end;
$function$;

drop trigger if exists trg_force_cloud_failure_fallback
  on public.salonboard_sync_jobs;
create trigger trg_force_cloud_failure_fallback
after update of status, executor, attempts, error
on public.salonboard_sync_jobs
for each row
when (
  new.executor = 'playwright_cloud'
  and new.job_type in ('push_booking', 'cancel_booking', 'push_shifts')
  and new.status in ('queued', 'failed')
)
execute function public.salonboard_force_cloud_failure_fallback();

-- Move currently stranded Cloud-conflict jobs, including the WAO! 新宿店
-- booking reported during this incident.  The predicate is semantic rather
-- than ID-based so every shop gets the same recovery.
update public.salonboard_sync_jobs
   set status = 'queued',
       executor = 'playwright',
       payload = coalesce(payload, '{}'::jsonb) || jsonb_build_object(
         'pc_fallback', true,
         'pc_fallback_at', now(),
         'pc_fallback_from', 'playwright_cloud',
         'pc_fallback_reason', 'cloud_retries_exhausted',
         'preflight_required', true
       ),
       attempts = 0,
       max_attempts = greatest(max_attempts, 3),
       run_at = now(),
       completed_at = null,
       locked_at = null,
       locked_by = null,
       error = left(
         '[CLOUD_PC_FALLBACK] Cloudで3回完了できなかったため店舗PCで再実行します: '
           || replace(
                replace(
                  regexp_replace(
                    coalesce(error, 'Cloud処理が完了しませんでした'),
                    '^\[CLOUD_PC_FALLBACK\][^:]*:\s*',
                    ''
                  ),
                  '最新情報からCloudで全工程を再試行します。',
                  '店舗PCで全工程を再試行します。'
                ),
                '同じCloudで全工程を自動再試行します',
                '店舗PCで全工程を再試行します'
              ),
         1000
       ),
       updated_at = now()
 where executor = 'playwright_cloud'
   and job_type in ('push_booking', 'cancel_booking', 'push_shifts')
   and status in ('queued', 'failed')
   and (
     coalesce(error, '') ~
       'KPCL017V01|SB_SERVER_ERROR|JOB_TIMEOUT|STALE_LOCK_RETRY_EXHAUSTED'
     or attempts >= greatest(max_attempts, 3)
   );
