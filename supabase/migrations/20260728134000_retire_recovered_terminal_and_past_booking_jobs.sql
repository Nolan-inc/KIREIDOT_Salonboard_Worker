-- The legacy PC-to-Cloud recovery intentionally restored old failed writes, but
-- historical orphan rows (including already-finished reservations) must not be
-- replayed forever.  They consume Cloud lanes and create failures that can no
-- longer change the operational schedule.
--
-- Keep future confirmed reservations queued.  Retire only:
--   1. terminal KIREIDOT bookings, regardless of push action; and
--   2. rows explicitly recovered from a 24h orphan state whose appointment has
--      already passed by more than one hour.

create or replace function public.salonboard_enrich_job_booking_status()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_booking_status text;
  v_booking_id uuid;
  v_scheduled_at timestamptz;
  v_terminal boolean := false;
  v_recovered_past_orphan boolean := false;
begin
  if new.job_type <> 'push_booking'
     or coalesce(new.payload->>'booking_id', '') !~
        '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
  then
    return new;
  end if;

  v_booking_id := (new.payload->>'booking_id')::uuid;
  select b.status::text, b.scheduled_at
    into v_booking_status, v_scheduled_at
    from public.bookings b
   where b.id = v_booking_id;

  if v_booking_status is not null then
    new.payload := jsonb_set(
      coalesce(new.payload, '{}'::jsonb),
      '{booking_status}',
      to_jsonb(v_booking_status),
      true
    );
  end if;

  v_terminal := v_booking_status in ('completed', 'cancelled', 'no_show');
  v_recovered_past_orphan :=
    position('[自動終了: 24時間以上滞留(orphan)' in coalesce(new.error, '')) > 0
    and position('[RECOVER_LEGACY_PC_TO_CLOUD]' in coalesce(new.error, '')) > 0
    and v_scheduled_at < now() - interval '1 hour';

  if (v_terminal or v_recovered_past_orphan)
     and new.status in (
       'queued', 'running', 'retryable_failed', 'failed', 'manual_required'
     )
  then
    new.status := 'cancelled';
    new.completed_at := coalesce(new.completed_at, now());
    new.locked_at := null;
    new.locked_by := null;
    new.error := concat_ws(
      ' ',
      nullif(new.error, ''),
      case
        when v_terminal then format(
          '[TERMINAL_BOOKING_PUSH_SKIPPED] booking status is %s; SalonBoard push is no longer applicable',
          v_booking_status
        )
        else '[RECOVERED_PAST_ORPHAN_RETIRED] appointment already passed; legacy replay stopped'
      end
    );
    new.result := coalesce(new.result, '{}'::jsonb) || jsonb_build_object(
      'booking_push_skipped', true,
      'booking_status', v_booking_status,
      'scheduled_at', v_scheduled_at,
      'skipped_at', now()
    );
  end if;

  return new;
end;
$$;

revoke all on function public.salonboard_enrich_job_booking_status() from public;

-- Correct the rows that the one-time legacy recovery already placed back on
-- Cloud.  Preserve the complete error/result history for auditability.
update public.salonboard_sync_jobs j
   set status = 'cancelled',
       completed_at = now(),
       locked_at = null,
       locked_by = null,
       error = concat_ws(
         ' ',
         nullif(j.error, ''),
         case
           when b.status::text in ('completed', 'cancelled', 'no_show')
             then format(
               '[TERMINAL_BOOKING_PUSH_SKIPPED] booking status is %s; SalonBoard push is no longer applicable',
               b.status::text
             )
           else '[RECOVERED_PAST_ORPHAN_RETIRED] appointment already passed; legacy replay stopped'
         end
       ),
       result = coalesce(j.result, '{}'::jsonb) || jsonb_build_object(
         'booking_push_skipped', true,
         'booking_status', b.status::text,
         'scheduled_at', b.scheduled_at,
         'skipped_at', now()
       ),
       payload = jsonb_set(
         coalesce(j.payload, '{}'::jsonb),
         '{booking_status}',
         to_jsonb(b.status::text),
         true
       ),
       updated_at = now()
  from public.bookings b
 where j.job_type = 'push_booking'
   and j.payload->>'booking_id' = b.id::text
   and j.status in (
     'queued', 'running', 'retryable_failed', 'failed', 'manual_required'
   )
   and (
     b.status::text in ('completed', 'cancelled', 'no_show')
     or (
       position('[自動終了: 24時間以上滞留(orphan)' in coalesce(j.error, '')) > 0
       and position('[RECOVER_LEGACY_PC_TO_CLOUD]' in coalesce(j.error, '')) > 0
       and b.scheduled_at < now() - interval '1 hour'
     )
   );
