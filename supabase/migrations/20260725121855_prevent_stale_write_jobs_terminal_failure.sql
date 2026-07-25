-- A Cloud write may outlive the in-process timeout while Playwright is
-- unwinding after Chrome is closed.  Historically the stale-lock reaper
-- counted each such incident as a full attempt and eventually changed the job
-- to terminal failed, even when SalonBoard had already accepted the write.
--
-- Technical worker loss is recoverable and must never be the final business
-- outcome.  Keep the job queued, reset the attempt cycle when necessary, and
-- rely on each write flow's preflight/reconciliation to make replay
-- idempotent.  Permanent input/configuration errors are still reported by the
-- normal callback as manual_required/failed and are not touched here.

create or replace function public.salonboard_reap_write_jobs(
  p_timeout_seconds integer default 420
)
returns integer
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_job record;
  v_booking_id text;
  v_count integer := 0;
begin
  for v_job in
    select j.*
      from public.salonboard_sync_jobs j
     where j.status = 'running'
       and j.job_type in (
         'push_booking','cancel_booking','push_shifts','push_blog','delete_blog',
         'push_photo_gallery','delete_photo_gallery','push_review_reply'
       )
       and j.locked_at is not null
       and j.locked_at < now() - make_interval(
         secs => case
           when j.job_type = 'push_shifts' then greatest(p_timeout_seconds, 900)
           else greatest(p_timeout_seconds, 420)
         end
       )
     order by j.locked_at
     for update skip locked
  loop
    v_booking_id := nullif(v_job.payload->>'booking_id', '');

    if v_job.job_type = 'push_booking'
       and coalesce(v_job.payload->>'action', 'create') <> 'create'
       and v_booking_id is not null
       and exists (
         select 1 from public.bookings b
          where b.id = v_booking_id::uuid
            and nullif(btrim(coalesce(b.external_booking_id, '')), '') is null
       )
       and exists (
         select 1 from public.salonboard_sync_jobs x
          where x.id <> v_job.id
            and x.payload->>'booking_id' = v_booking_id
            and x.job_type = 'push_booking'
            and coalesce(x.payload->>'action', 'create') = 'create'
            and x.status in ('queued','scheduled','running','retryable_failed')
       )
    then
      update public.salonboard_sync_jobs
         set status = 'cancelled',
             completed_at = now(),
             locked_at = null,
             locked_by = null,
             error = left(
               coalesce(error, '') ||
               ' [SUPERSEDED_DUPLICATE] external_booking_id未取得のcreateジョブへ統合',
               1000
             ),
             updated_at = now()
       where id = v_job.id;
      v_count := v_count + 1;
      continue;
    end if;

    if v_booking_id is not null then
      update public.salonboard_sync_jobs
         set status = 'cancelled',
             completed_at = now(),
             locked_at = null,
             locked_by = null,
             error = left(
               coalesce(error, '') ||
               ' [SUPERSEDED_DUPLICATE] stale実行ジョブへ統合',
               1000
             ),
             updated_at = now()
       where id <> v_job.id
         and payload->>'booking_id' = v_booking_id
         and status in ('queued','scheduled','retryable_failed');
    end if;

    update public.salonboard_sync_jobs
       set status = 'queued',
           executor = v_job.executor,
           attempts = case
             when v_job.attempts >= greatest(v_job.max_attempts, 3) then 0
             else v_job.attempts
           end,
           max_attempts = greatest(v_job.max_attempts, 3),
           run_at = now() + interval '1 minute',
           completed_at = null,
           locked_at = null,
           locked_by = null,
           payload = case
             when v_job.job_type in ('push_booking', 'cancel_booking')
               then coalesce(v_job.payload, '{}'::jsonb)
                 || jsonb_build_object(
                      'preflight_required', true,
                      'stale_recovery_count',
                      case
                        when coalesce(v_job.payload->>'stale_recovery_count', '') ~ '^[0-9]+$'
                          then (v_job.payload->>'stale_recovery_count')::integer + 1
                        else 1
                      end
                    )
             else coalesce(v_job.payload, '{}'::jsonb)
                 || jsonb_build_object(
                      'stale_recovery_count',
                      case
                        when coalesce(v_job.payload->>'stale_recovery_count', '') ~ '^[0-9]+$'
                          then (v_job.payload->>'stale_recovery_count')::integer + 1
                        else 1
                      end
                    )
           end,
           error = left(
             coalesce(error, '') ||
             ' [AUTO_RECOVERED_STALE_LOCK] worker停止を検知。失敗確定せず1分後に冪等再試行',
             1000
           ),
           updated_at = now()
     where id = v_job.id;
    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$function$;

-- Recover only the terminal technical failures created by the old reaper.
-- Reconciliation/preflight is forced because some of these writes actually
-- completed in SalonBoard after the former timeout callback was emitted.
update public.salonboard_sync_jobs
   set status = 'queued',
       attempts = 0,
       max_attempts = greatest(max_attempts, 3),
       run_at = now() + interval '1 minute',
       completed_at = null,
       locked_at = null,
       locked_by = null,
       payload = case
         when job_type in ('push_booking', 'cancel_booking')
           then coalesce(payload, '{}'::jsonb)
             || jsonb_build_object(
                  'preflight_required', true,
                  'recovered_from_terminal_timeout', true
                )
         else coalesce(payload, '{}'::jsonb)
             || jsonb_build_object('recovered_from_terminal_timeout', true)
       end,
       error = left(
         coalesce(error, '') ||
         ' [TERMINAL_TIMEOUT_REQUEUED] 技術的タイムアウトを失敗確定せず再処理',
         1000
       ),
       updated_at = now()
 where status = 'failed'
   and job_type in ('push_booking', 'cancel_booking', 'push_shifts')
   and (
     coalesce(error, '') like '%[JOB_TIMEOUT]%'
     or coalesce(error, '') like '%[STALE_LOCK_RETRY_EXHAUSTED]%'
   );
