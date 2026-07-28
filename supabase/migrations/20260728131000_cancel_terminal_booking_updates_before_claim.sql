-- A completed/cancelled/no-show KIREIDOT booking cannot be edited in SalonBoard.
-- The Admin jobs API hydrates push_booking payloads before returning them to a worker,
-- and historically omitted booking_status from that hydrated payload.  Enforce this
-- invariant in Postgres so these jobs never enter the Cloud claim/retry loop.

create or replace function public.salonboard_enrich_job_booking_status()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_booking_status text;
  v_booking_id uuid;
begin
  if new.job_type <> 'push_booking'
     or coalesce(new.payload->>'booking_id', '') !~
        '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
  then
    return new;
  end if;

  v_booking_id := (new.payload->>'booking_id')::uuid;
  select b.status::text
    into v_booking_status
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

  if coalesce(new.payload->>'action', '') = 'update'
     and v_booking_status in ('completed', 'cancelled', 'no_show')
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
      format(
        '[TERMINAL_BOOKING_UPDATE_SKIPPED] booking status is %s; SalonBoard update is no longer applicable',
        v_booking_status
      )
    );
    new.result := coalesce(new.result, '{}'::jsonb) || jsonb_build_object(
      'terminal_booking_update_skipped', true,
      'booking_status', v_booking_status,
      'skipped_at', now()
    );
  end if;

  return new;
end;
$$;

revoke all on function public.salonboard_enrich_job_booking_status() from public;

-- Stop all currently queued/running terminal updates immediately.  Preserve the
-- original error for auditability while making the current state unambiguous.
update public.salonboard_sync_jobs j
   set status = 'cancelled',
       completed_at = now(),
       locked_at = null,
       locked_by = null,
       error = concat_ws(
         ' ',
         nullif(j.error, ''),
         format(
           '[TERMINAL_BOOKING_UPDATE_SKIPPED] booking status is %s; SalonBoard update is no longer applicable',
           b.status::text
         )
       ),
       result = coalesce(j.result, '{}'::jsonb) || jsonb_build_object(
         'terminal_booking_update_skipped', true,
         'booking_status', b.status::text,
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
   and j.payload->>'action' = 'update'
   and j.payload->>'booking_id' = b.id::text
   and b.status::text in ('completed', 'cancelled', 'no_show')
   and j.status in (
     'queued', 'running', 'retryable_failed', 'failed', 'manual_required'
   );
