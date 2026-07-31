-- Booking writes are an eventual-consistency contract, including historical
-- appointments.  Do not silently retire a SalonBoard write merely because the
-- appointment has passed or the KIREIDOT booking reached completed/no_show.
-- SalonBoard accepts past writes with a warning; if a particular record is no
-- longer editable, the worker must surface that concrete exception instead.

create or replace function public.bookings_autolink_staff()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_staff_external_id text;
  v_staff_name text;
begin
  if new.staff_id is null
     and new.salonboard_staff_name is not null
     and new.shop_id is not null
  then
    new.staff_id := public.resolve_salonboard_staff_id(
      new.shop_id,
      new.salonboard_staff_name
    );
  end if;

  if new.staff_id is not null then
    select nullif(btrim(s.salonboard_external_id), ''), s.full_name
      into v_staff_external_id, v_staff_name
      from public.staff s
     where s.id = new.staff_id;

    if v_staff_external_id is not null then
      new.salonboard_staff_external_id := v_staff_external_id;
    end if;
    if nullif(btrim(coalesce(new.salonboard_staff_name, '')), '') is null
       and nullif(btrim(coalesce(v_staff_name, '')), '') is not null
    then
      new.salonboard_staff_name := v_staff_name;
    end if;
  end if;

  return new;
end;
$$;

revoke all on function public.bookings_autolink_staff() from public;

-- Hydrate every push job from the canonical booking row, but never change its
-- lifecycle status here.  A previous version changed historical/terminal jobs to
-- cancelled, which violated the synchronization guarantee and hid real drift.
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
  if new.job_type <> 'push_booking'
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

-- Historical writes get the same retry policy as future writes.  Keep the
-- function for compatibility with environments that already reference it, but
-- remove the trigger that reduced past writes to one low-priority attempt.
drop trigger if exists trg_zzzzz_deprioritize_past_writes
  on public.salonboard_sync_jobs;

create or replace function public.salonboard_deprioritize_past_writes()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  return new;
end;
$$;

revoke all on function public.salonboard_deprioritize_past_writes() from public;

-- Enqueue updates regardless of current appointment date/status.  This is an
-- AFTER UPDATE trigger and only fires when synchronized booking fields actually
-- changed, so it does not replay untouched historical rows.
create or replace function public.bookings_autoenqueue_salonboard_update()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org_id uuid;
  v_enabled boolean;
  v_push_enabled boolean;
  v_blocked_until timestamptz;
  v_write_cooldown_until timestamptz;
  v_run_at timestamptz;
  v_existing integer;
  v_has_external_id boolean;
begin
  if pg_trigger_depth() > 1 then return new; end if;
  if new.source = 'salonboard' then return new; end if;

  if new.scheduled_at is not distinct from old.scheduled_at
     and new.duration_min is not distinct from old.duration_min
     and new.staff_id is not distinct from old.staff_id
     and new.menu_id is not distinct from old.menu_id
     and new.resource_id is not distinct from old.resource_id
     and new.customer_id is not distinct from old.customer_id
     and new.customer_name is not distinct from old.customer_name
     and new.notes is not distinct from old.notes
     and new.coupon_name is not distinct from old.coupon_name
     and new.booking_type is not distinct from old.booking_type
     and new.block_reason is not distinct from old.block_reason
  then
    return new;
  end if;

  select c.organization_id, c.enabled, c.sync_push_enabled,
         c.blocked_until, c.write_cooldown_until
    into v_org_id, v_enabled, v_push_enabled,
         v_blocked_until, v_write_cooldown_until
    from public.salonboard_credentials c
   where c.shop_id = new.shop_id
   limit 1;
  if v_org_id is null or v_enabled is not true or v_push_enabled is false then
    return new;
  end if;

  v_run_at := greatest(
    now(),
    coalesce(v_blocked_until, now()),
    coalesce(v_write_cooldown_until, now())
  );
  v_has_external_id := nullif(btrim(coalesce(new.external_booking_id, '')), '') is not null;

  select count(*) into v_existing
    from public.salonboard_sync_jobs j
   where j.shop_id = new.shop_id
     and j.job_type = 'push_booking'
     and j.status in ('queued', 'scheduled', 'running', 'retryable_failed')
     and j.payload->>'booking_id' = new.id::text;
  if v_existing > 0 then return new; end if;

  insert into public.salonboard_sync_jobs
    (shop_id, organization_id, job_type, priority, run_at, max_attempts, payload)
  values (
    new.shop_id,
    v_org_id,
    'push_booking',
    case when v_has_external_id then 2 else 100 end,
    v_run_at,
    case when v_has_external_id then 3 else 10 end,
    case when v_has_external_id
      then jsonb_build_object('booking_id', new.id, 'action', 'update')
      else jsonb_build_object(
        'booking_id', new.id,
        'action', 'create',
        'preflight_required', true
      )
    end
  );

  update public.bookings
     set salonboard_sync_status = 'pending_push',
         salonboard_last_push_error = null
   where id = new.id;
  return new;
exception when others then
  return new;
end;
$$;

revoke all on function public.bookings_autoenqueue_salonboard_update() from public;
