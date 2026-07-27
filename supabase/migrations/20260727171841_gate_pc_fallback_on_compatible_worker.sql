-- Keep booking/cancel/shift writes in Cloud unless a current, compatible PC
-- worker is online.  Older desktop workers still classify a confirmed
-- registration without reserveId as a failure and can emit false error
-- notifications even though SalonBoard accepted the booking.
--
-- Cloud remains the primary executor.  PC fallback is retained for operators
-- who explicitly requested it, but only when the PC is new enough to contain
-- the completion-without-reserveId fix (v0.2.231+) and has a fresh heartbeat.

create or replace function public.salonboard_force_cloud_failure_fallback()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_should_fallback boolean;
  v_compatible_pc_online boolean := false;
  v_error text;
  v_retry_cycle integer;
begin
  -- The update below intentionally changes the same row.  Do not process the
  -- nested trigger invocation a second time.
  if pg_trigger_depth() > 1 then
    return new;
  end if;

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

  select exists (
    select 1
      from public.salonboard_worker_heartbeats h
      cross join lateral regexp_match(
        coalesce(h.app_version, ''),
        '^([0-9]+)\.([0-9]+)\.([0-9]+)'
      ) as parsed(parts)
     where h.is_active is true
       and h.enable_push is true
       and h.last_seen_at >= now() - interval '2 minutes'
       and (
         parsed.parts[1]::integer,
         parsed.parts[2]::integer,
         parsed.parts[3]::integer
       ) >= (0, 2, 231)
  )
  into v_compatible_pc_online;

  v_error := regexp_replace(
    coalesce(new.error, 'Cloud処理が完了しませんでした'),
    '^\[(CLOUD_PC_FALLBACK|CLOUD_RETRY_NO_COMPATIBLE_PC)\][^:]*:\s*',
    ''
  );

  if not v_compatible_pc_online then
    v_retry_cycle :=
      case
        when coalesce(new.payload->>'cloud_retry_cycle', '') ~ '^[0-9]+$'
          then (new.payload->>'cloud_retry_cycle')::integer + 1
        else 1
      end;

    update public.salonboard_sync_jobs
       set status = 'queued',
           executor = 'playwright_cloud',
           payload = (
             coalesce(payload, '{}'::jsonb)
               - 'pc_fallback'
               - 'pc_fallback_at'
               - 'pc_fallback_from'
               - 'pc_fallback_reason'
           ) || jsonb_build_object(
             'cloud_retry_cycle', v_retry_cycle,
             'cloud_retry_after_pc_gate_at', now(),
             'pc_fallback_blocked_reason', 'no_compatible_pc_v0_2_231',
             'preflight_required', true
           ),
           attempts = 0,
           max_attempts = greatest(max_attempts, 3),
           run_at = now() + interval '1 minute',
           completed_at = null,
           locked_at = null,
           locked_by = null,
           error = left(
             '[CLOUD_RETRY_NO_COMPATIBLE_PC] v0.2.231以上の稼働中PCがないため、'
               || '旧PCへ移管せずCloudで全工程を再試行します: '
               || v_error,
             1000
           ),
           updated_at = now()
     where id = new.id;

    return new;
  end if;

  v_error := replace(
    replace(
      v_error,
      '最新情報からCloudで全工程を再試行します。',
      '互換PCで全工程を再試行します。'
    ),
    '同じCloudで全工程を自動再試行します',
    '互換PCで全工程を再試行します'
  );

  update public.salonboard_sync_jobs
     set status = 'queued',
         executor = 'playwright',
         payload = coalesce(payload, '{}'::jsonb) || jsonb_build_object(
           'pc_fallback', true,
           'pc_fallback_at', now(),
           'pc_fallback_from', 'playwright_cloud',
           'pc_fallback_reason', 'cloud_retries_exhausted_compatible_pc',
           'preflight_required', true
         ),
         attempts = 0,
         max_attempts = greatest(max_attempts, 3),
         run_at = now(),
         completed_at = null,
         locked_at = null,
         locked_by = null,
         error = left(
           '[CLOUD_PC_FALLBACK] Cloudで3回完了できなかったため'
             || '互換PCで再実行します: '
             || v_error,
           1000
         ),
         updated_at = now()
   where id = new.id;

  return new;
end;
$function$;

revoke all on function public.salonboard_force_cloud_failure_fallback()
  from public, anon, authenticated;

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

-- Recover jobs that were handed to an old PC but have not started there yet.
-- Completed history is intentionally preserved.
update public.salonboard_sync_jobs
   set status = 'queued',
       executor = 'playwright_cloud',
       payload = (
         coalesce(payload, '{}'::jsonb)
           - 'pc_fallback'
           - 'pc_fallback_at'
           - 'pc_fallback_from'
           - 'pc_fallback_reason'
       ) || jsonb_build_object(
         'cloud_retry_cycle',
           case
             when coalesce(payload->>'cloud_retry_cycle', '') ~ '^[0-9]+$'
               then (payload->>'cloud_retry_cycle')::integer + 1
             else 1
           end,
         'cloud_retry_after_pc_gate_at', now(),
         'pc_fallback_blocked_reason', 'no_compatible_pc_v0_2_231',
         'preflight_required', true
       ),
       attempts = 0,
       max_attempts = greatest(max_attempts, 3),
       run_at = now() + interval '1 minute',
       completed_at = null,
       locked_at = null,
       locked_by = null,
       error = '[CLOUD_RETRY_NO_COMPATIBLE_PC] 旧PCへの未着手移管を取り消し、Cloudで再試行します。',
       updated_at = now()
 where executor = 'playwright'
   and job_type in ('push_booking', 'cancel_booking', 'push_shifts')
   and status in ('queued', 'retryable_failed')
   and coalesce(payload->>'pc_fallback', 'false') = 'true'
   and not exists (
     select 1
       from public.salonboard_worker_heartbeats h
       cross join lateral regexp_match(
         coalesce(h.app_version, ''),
         '^([0-9]+)\.([0-9]+)\.([0-9]+)'
       ) as parsed(parts)
      where h.is_active is true
        and h.enable_push is true
        and h.last_seen_at >= now() - interval '2 minutes'
        and (
          parsed.parts[1]::integer,
          parsed.parts[2]::integer,
          parsed.parts[3]::integer
        ) >= (0, 2, 231)
   );
