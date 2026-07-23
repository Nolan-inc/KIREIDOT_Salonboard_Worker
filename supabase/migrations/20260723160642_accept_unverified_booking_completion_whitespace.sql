-- Legacy desktop workers can report a completed SalonBoard registration as
-- failed when the completion page does not expose reserveId.  The registration
-- has already crossed the irreversible submit boundary, so retrying can create
-- a duplicate.  Accept both historical message variants (`reserveIdを` and
-- `reserveId を`) and keep the job/booking result consistent.
create or replace function public.salonboard_accept_unverified_booking_completion()
returns trigger
language plpgsql
security definer
set search_path = public
as $function$
begin
  if new.job_type = 'push_booking'
     and new.status in ('failed', 'retryable_failed')
     and position('登録の完了サインは出ましたが' in coalesce(new.error, '')) > 0
     and coalesce(new.error, '') ~ 'reserveId[[:space:]]*を確認できませんでした'
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

-- Reconcile rows that were written before this whitespace-tolerant guard was
-- deployed.  The existing AFTER trigger updates the related booking to synced.
update public.salonboard_sync_jobs
   set status = 'succeeded',
       completed_at = coalesce(completed_at, now()),
       locked_at = null,
       locked_by = null,
       result = coalesce(result, '{}'::jsonb) || jsonb_build_object(
         'ok', true,
         'id_unverified', true,
         'completion_sign_observed', true
       ),
       error = null
 where job_type = 'push_booking'
   and status in ('failed', 'retryable_failed')
   and position('登録の完了サインは出ましたが' in coalesce(error, '')) > 0
   and coalesce(error, '') ~ 'reserveId[[:space:]]*を確認できませんでした';

-- Defensive reconciliation for environments where the earlier AFTER trigger
-- was not yet present when the historical rows were written.
update public.bookings b
   set salonboard_sync_status = 'synced',
       salonboard_last_push_error = null,
       updated_at = now()
  from public.salonboard_sync_jobs j
 where j.job_type = 'push_booking'
   and j.status = 'succeeded'
   and coalesce(j.result->>'id_unverified', 'false') = 'true'
   and nullif(j.payload->>'booking_id', '') is not null
   and b.id = (j.payload->>'booking_id')::uuid
   and (
     b.salonboard_sync_status is distinct from 'synced'
     or b.salonboard_last_push_error is not null
   );
