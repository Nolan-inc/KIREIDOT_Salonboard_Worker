-- SalonBoard sometimes renders the registration-complete sign without returning
-- a reserveId.  The write has already crossed the irreversible boundary, so an
-- old desktop worker must not turn that outcome into a failed/retryable job and
-- create a duplicate reservation on retry.
create or replace function public.salonboard_accept_unverified_booking_completion()
returns trigger
language plpgsql
security definer
set search_path = public
as $function$
begin
  if new.job_type = 'push_booking'
     and new.status in ('failed', 'retryable_failed')
     and coalesce(new.error, '') like '登録の完了サインは出ましたが reserveIdを確認できませんでした%'
  then
    new.status := 'succeeded';
    new.completed_at := coalesce(new.completed_at, now());
    new.locked_at := null;
    new.locked_by := null;
    new.result := coalesce(new.result, '{}'::jsonb) || jsonb_build_object(
      'ok', true,
      'id_unverified', true,
      'completion_sign_observed', true
    );
    new.error := null;
  end if;
  return new;
end;
$function$;

drop trigger if exists trg_accept_unverified_booking_completion
  on public.salonboard_sync_jobs;
create trigger trg_accept_unverified_booking_completion
before update of status, error on public.salonboard_sync_jobs
for each row
execute function public.salonboard_accept_unverified_booking_completion();

create or replace function public.salonboard_reconcile_unverified_booking_completion()
returns trigger
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_booking_id uuid;
begin
  if old.status is distinct from 'succeeded'
     and new.status = 'succeeded'
     and coalesce(new.result->>'id_unverified', 'false') = 'true'
     and nullif(new.payload->>'booking_id', '') is not null
  then
    v_booking_id := (new.payload->>'booking_id')::uuid;
    update public.bookings
       set salonboard_sync_status = 'synced',
           salonboard_last_push_error = null,
           updated_at = now()
     where id = v_booking_id;
  end if;
  return new;
exception when others then
  -- The job outcome is authoritative even if a legacy payload is malformed.
  return new;
end;
$function$;

drop trigger if exists trg_reconcile_unverified_booking_completion
  on public.salonboard_sync_jobs;
create trigger trg_reconcile_unverified_booking_completion
after update of status on public.salonboard_sync_jobs
for each row
execute function public.salonboard_reconcile_unverified_booking_completion();

