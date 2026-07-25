-- Older desktop workers classified KPCL017V01 as a permanent form mismatch.
-- It is actually SalonBoard's optimistic-lock conflict and must stay on the
-- shop-PC retry path until a fresh schedule token succeeds.

create or replace function public.salonboard_prevent_terminal_timeout_failure()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_is_timeout boolean;
  v_is_pc_conflict boolean;
  v_pc_recovery_count integer;
begin
  v_is_timeout :=
    coalesce(new.error, '') like '%[JOB_TIMEOUT]%'
    or coalesce(new.error, '') like '%[STALE_LOCK_RETRY_EXHAUSTED]%';

  v_is_pc_conflict :=
    new.executor = 'playwright'
    and coalesce(new.payload->>'pc_fallback', 'false') = 'true'
    and coalesce(new.error, '') ~
      'KPCL017V01|他のユーザによって変更されているため';

  if old.status = 'running'
     and new.status = 'failed'
     and new.job_type in ('push_booking', 'cancel_booking', 'push_shifts')
     and (v_is_timeout or v_is_pc_conflict)
  then
    v_pc_recovery_count := case
      when coalesce(new.payload->>'pc_conflict_recovery_count', '') ~ '^[0-9]+$'
        then (new.payload->>'pc_conflict_recovery_count')::integer + 1
      else 1
    end;

    new.status := 'queued';
    new.attempts := case
      when new.attempts >= greatest(new.max_attempts, 3) then 0
      else new.attempts
    end;
    new.max_attempts := greatest(new.max_attempts, 3);
    new.run_at := now() + interval '1 minute';
    new.completed_at := null;
    new.locked_at := null;
    new.locked_by := null;
    new.payload := coalesce(new.payload, '{}'::jsonb)
      || jsonb_build_object(
           'preflight_required', true,
           'recovered_from_terminal_timeout', v_is_timeout,
           'pc_conflict_recovery_count', v_pc_recovery_count
         );
    new.error := left(
      coalesce(new.error, '') ||
      case
        when v_is_pc_conflict
          then ' [PC_CONFLICT_REQUEUED] SalonBoard更新競合のため最新情報から店舗PCで再処理'
        else ' [TERMINAL_TIMEOUT_REQUEUED] 技術的タイムアウトを失敗確定せず1分後に再処理'
      end,
      1000
    );
  end if;
  return new;
end;
$function$;

-- Recover PC fallback rows that an older desktop worker already marked failed.
update public.salonboard_sync_jobs
   set status = 'queued',
       attempts = case
         when attempts >= greatest(max_attempts, 3) then 0
         else attempts
       end,
       max_attempts = greatest(max_attempts, 3),
       run_at = now() + interval '1 minute',
       completed_at = null,
       locked_at = null,
       locked_by = null,
       payload = coalesce(payload, '{}'::jsonb)
         || jsonb_build_object(
              'preflight_required', true,
              'pc_conflict_recovery_count',
              case
                when coalesce(payload->>'pc_conflict_recovery_count', '') ~ '^[0-9]+$'
                  then (payload->>'pc_conflict_recovery_count')::integer + 1
                else 1
              end
            ),
       error = left(
         coalesce(error, '') ||
         ' [PC_CONFLICT_REQUEUED] SalonBoard更新競合のため最新情報から店舗PCで再処理',
         1000
       ),
       updated_at = now()
 where executor = 'playwright'
   and coalesce(payload->>'pc_fallback', 'false') = 'true'
   and status = 'failed'
   and job_type in ('push_booking', 'cancel_booking', 'push_shifts')
   and coalesce(error, '') ~
     'KPCL017V01|他のユーザによって変更されているため';
