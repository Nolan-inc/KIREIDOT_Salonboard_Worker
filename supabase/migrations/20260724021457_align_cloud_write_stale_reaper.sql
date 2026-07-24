-- Cloud write jobs have an in-process safety timeout of 330 seconds.  The old
-- reaper defaulted to 180 seconds, so a healthy browser flow could be unlocked
-- and queued a second time while the first process was still submitting it.
-- Keep the crash-recovery threshold safely beyond the worker timeout and make
-- crash recovery immediately runnable (the worker already owns retry pacing).
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
       set status = case
             when v_job.attempts < greatest(v_job.max_attempts, 3) then 'queued'
             else 'failed'
           end,
           executor = v_job.executor,
           max_attempts = greatest(v_job.max_attempts, 3),
           run_at = case
             when v_job.attempts < greatest(v_job.max_attempts, 3) then now()
             else v_job.run_at
           end,
           completed_at = case
             when v_job.attempts < greatest(v_job.max_attempts, 3) then null
             else now()
           end,
           locked_at = null,
           locked_by = null,
           error = left(
             coalesce(error, '') ||
             case
               when v_job.attempts < greatest(v_job.max_attempts, 3)
                 then ' [AUTO_RECOVERED_STALE_LOCK] 7分超過のため同じCloudで即時再試行'
               else ' [STALE_LOCK_RETRY_EXHAUSTED] worker停止が3回続いたため終了'
             end,
             1000
           ),
           updated_at = now()
     where id = v_job.id;
    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$function$;
