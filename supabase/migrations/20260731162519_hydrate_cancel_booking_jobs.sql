-- Cancellation retries need the same canonical booking snapshot as push jobs.
-- In particular, the hair-salon schedule fallback verifies the customer/time
-- before clicking, so losing customer_name while cloning a failed job makes an
-- otherwise recoverable cancellation impossible.
create or replace function public.salonboard_enrich_job_booking_status()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_booking_id uuid;
  v_booking public.bookings%rowtype;
  v_staff_external_id text;
  v_staff_name text;
begin
  if new.job_type not in ('push_booking', 'cancel_booking')
     or coalesce(new.payload->>'booking_id', '') !~
        '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
  then
    return new;
  end if;

  v_booking_id := (new.payload->>'booking_id')::uuid;
  select b.* into v_booking
    from public.bookings b
   where b.id = v_booking_id;
  if not found then
    return new;
  end if;

  select nullif(btrim(s.salonboard_external_id), ''), s.full_name
    into v_staff_external_id, v_staff_name
    from public.staff s
   where s.id = v_booking.staff_id;

  new.payload := coalesce(new.payload, '{}'::jsonb)
    || jsonb_strip_nulls(jsonb_build_object(
      'booking_status', v_booking.status::text,
      'scheduled_at', v_booking.scheduled_at,
      'duration_min', v_booking.duration_min,
      'booking_type', v_booking.booking_type,
      'block_reason', v_booking.block_reason,
      'external_booking_id', v_booking.external_booking_id,
      'salonboard_staff_external_id', coalesce(
        nullif(btrim(v_booking.salonboard_staff_external_id), ''),
        v_staff_external_id
      ),
      'salonboard_staff_name', coalesce(
        nullif(btrim(v_booking.salonboard_staff_name), ''),
        v_staff_name
      ),
      'staff_name', coalesce(
        nullif(btrim(v_booking.salonboard_staff_name), ''),
        v_staff_name
      ),
      'salonboard_equipment_external_id', v_booking.salonboard_equipment_external_id,
      'salonboard_equipment_name', v_booking.salonboard_equipment_name,
      'customer_name', v_booking.customer_name
    ));

  return new;
end;
$$;

revoke all on function public.salonboard_enrich_job_booking_status() from public;
