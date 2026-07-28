-- A Cloud worker callback records a deterministic/manual failure in
-- salonboard_write_attempts before updating the job row.  The Cloud->PC
-- fallback trigger used to requeue every failed Cloud write, including
-- manual_required results such as EQUIPMENT_FULL and SLOT_NOT_AVAILABLE.
-- That produced an infinite one-minute retry loop for conditions automation
-- cannot safely solve.
--
-- Only retry/fallback failures whose latest write attempt is not
-- manual_required.  A later explicit retry creates a newer attempt, so this
-- does not prevent an operator from retrying after correcting the data.

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
  v_latest_attempt_status text;
begin
  if pg_trigger_depth() > 1 then
    return new;
  end if;

  select wa.status
    into v_latest_attempt_status
    from public.salonboard_write_attempts wa
   where wa.job_id = new.id
   order by wa.created_at desc, wa.id desc
   limit 1;

  v_should_fallback :=
    new.executor = 'playwright_cloud'
    and new.job_type in ('push_booking', 'cancel_booking', 'push_shifts')
    and v_latest_attempt_status is distinct from 'manual_required'
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

-- Retire deterministic business conflicts already caught in the old loop.
-- Their write-attempt audit rows remain available for the operator.
with latest_attempt as (
  select distinct on (wa.job_id)
         wa.job_id, wa.error_code, wa.error_message
    from public.salonboard_write_attempts wa
   where wa.status = 'manual_required'
   order by wa.job_id, wa.created_at desc, wa.id desc
)
update public.salonboard_sync_jobs j
   set status = 'failed',
       attempts = greatest(j.attempts, j.max_attempts),
       completed_at = now(),
       locked_at = null,
       locked_by = null,
       error = left(la.error_message, 1000),
       updated_at = now()
  from latest_attempt la
 where j.id = la.job_id
   and j.executor = 'playwright_cloud'
   and j.status in ('queued', 'running', 'retryable_failed')
   and la.error_code in ('EQUIPMENT_FULL', 'SLOT_NOT_AVAILABLE');
