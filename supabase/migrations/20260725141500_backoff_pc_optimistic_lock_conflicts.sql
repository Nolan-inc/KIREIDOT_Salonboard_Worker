-- Repeated optimistic-lock conflicts usually mean another SalonBoard session
-- is actively updating the same salon. Back off instead of retrying every
-- minute and continuously invalidating rlastupdate.

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
  v_retry_delay interval;
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
    v_retry_delay := case
      when v_is_pc_conflict and v_pc_recovery_count >= 6 then interval '15 minutes'
      when v_is_pc_conflict and v_pc_recovery_count >= 3 then interval '5 minutes'
      else interval '1 minute'
    end;

    new.status := 'queued';
    new.attempts := case
      when new.attempts >= greatest(new.max_attempts, 3) then 0
      else new.attempts
    end;
    new.max_attempts := greatest(new.max_attempts, 3);
    new.run_at := now() + v_retry_delay;
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
          then format(
            ' [PC_CONFLICT_REQUEUED] SalonBoard更新競合のため%s分待機して店舗PCで再処理',
            extract(epoch from v_retry_delay)::integer / 60
          )
        else ' [TERMINAL_TIMEOUT_REQUEUED] 技術的タイムアウトを失敗確定せず1分後に再処理'
      end,
      1000
    );
  end if;
  return new;
end;
$function$;
