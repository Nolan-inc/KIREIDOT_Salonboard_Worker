-- Keep the canonical SalonBoard staff identity in lockstep with bookings.staff_id.
-- A staff reassignment must never retain the previous SalonBoard name/external_id.
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
    select nullif(btrim(s.salonboard_external_id), ''),
           nullif(btrim(s.full_name), '')
      into v_staff_external_id, v_staff_name
      from public.staff s
     where s.id = new.staff_id;

    new.salonboard_staff_external_id := v_staff_external_id;
    new.salonboard_staff_name := v_staff_name;
  end if;

  return new;
end;
$$;

revoke all on function public.bookings_autolink_staff() from public;

-- Hydrate writes from the currently assigned KIREIDOT staff first.  Booking
-- snapshot columns remain a fallback only for legacy rows without a staff link.
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

  select nullif(btrim(s.salonboard_external_id), ''),
         nullif(btrim(s.full_name), '')
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
        v_staff_external_id,
        nullif(btrim(v_booking.salonboard_staff_external_id), '')
      ),
      'salonboard_staff_name', coalesce(
        v_staff_name,
        nullif(btrim(v_booking.salonboard_staff_name), '')
      ),
      'staff_name', coalesce(
        v_staff_name,
        nullif(btrim(v_booking.salonboard_staff_name), '')
      ),
      'salonboard_equipment_external_id', v_booking.salonboard_equipment_external_id,
      'salonboard_equipment_name', v_booking.salonboard_equipment_name,
      'customer_name', v_booking.customer_name
    ));

  return new;
end;
$$;

revoke all on function public.salonboard_enrich_job_booking_status() from public;

-- Enqueue only staff/month combinations whose KIREIDOT shift edit is newer than
-- the latest successful push that actually included that staff member.
create or replace function public.salonboard_enqueue_pending_shift_catchup(
  p_shop_id uuid,
  p_reason text default 'push_reenabled_catchup'
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_inserted integer := 0;
begin
  with staff_changes as (
    select sh.shop_id,
           sh.staff_id,
           to_char(sh.start_at at time zone 'Asia/Tokyo', 'YYYYMM') as month_key,
           max(sh.updated_at) as last_shift_edit
      from public.shifts sh
      join public.salonboard_staff_imports si
        on si.shop_id = sh.shop_id
       and si.matched_staff_id = sh.staff_id
     where sh.shop_id = p_shop_id
       and coalesce(sh.note, '') <> 'SalonBoard取込'
       and (sh.start_at at time zone 'Asia/Tokyo')::date >=
           date_trunc('month', now() at time zone 'Asia/Tokyo')::date
       and (sh.start_at at time zone 'Asia/Tokyo')::date <
           (date_trunc('month', now() at time zone 'Asia/Tokyo') + interval '7 months')::date
     group by sh.shop_id, sh.staff_id,
              to_char(sh.start_at at time zone 'Asia/Tokyo', 'YYYYMM')
  ), unsynced as (
    select sc.*
      from staff_changes sc
     where not exists (
       select 1
         from public.salonboard_sync_jobs done
        where done.shop_id = sc.shop_id
          and done.job_type = 'push_shifts'
          and done.status = 'succeeded'
          and done.payload->>'month' = sc.month_key
          and coalesce(done.completed_at, done.updated_at) >= sc.last_shift_edit
          and (
            not (done.payload ? 'staff_ids')
            or done.payload->'staff_ids' ? sc.staff_id::text
          )
     )
  ), monthly as (
    select u.shop_id,
           u.month_key,
           jsonb_agg(distinct u.staff_id::text) as staff_ids
      from unsynced u
     group by u.shop_id, u.month_key
  ), inserted as (
    insert into public.salonboard_sync_jobs
      (shop_id, organization_id, job_type, priority, payload, run_at, max_attempts)
    select m.shop_id,
           c.organization_id,
           'push_shifts',
           20,
           jsonb_build_object(
             'month', m.month_key,
             'staff_ids', m.staff_ids,
             'reason', p_reason
           ),
           greatest(
             now() + interval '15 seconds',
             coalesce(c.blocked_until, now()),
             coalesce(c.write_cooldown_until, now())
           ),
           3
      from monthly m
      join public.salonboard_credentials c on c.shop_id = m.shop_id
     where c.enabled is true
       and c.sync_push_enabled is true
       and not exists (
         select 1
           from public.salonboard_sync_jobs active
          where active.shop_id = m.shop_id
            and active.job_type = 'push_shifts'
            and active.status in ('queued', 'scheduled', 'running')
            and active.payload->>'month' = m.month_key
       )
    returning 1
  )
  select count(*) into v_inserted from inserted;

  return v_inserted;
end;
$$;

revoke all on function public.salonboard_enqueue_pending_shift_catchup(uuid, text) from public;

create or replace function public.salonboard_catchup_shifts_on_push_enable()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.enabled is true
     and new.sync_push_enabled is true
     and not (old.enabled is true and old.sync_push_enabled is true)
  then
    perform public.salonboard_enqueue_pending_shift_catchup(
      new.shop_id,
      'push_reenabled_catchup'
    );
  end if;
  return new;
exception when others then
  return new;
end;
$$;

drop trigger if exists salonboard_credentials_catchup_shifts_on_push_enable
  on public.salonboard_credentials;
create trigger salonboard_credentials_catchup_shifts_on_push_enable
after update of enabled, sync_push_enabled on public.salonboard_credentials
for each row execute function public.salonboard_catchup_shifts_on_push_enable();

revoke all on function public.salonboard_catchup_shifts_on_push_enable() from public;

-- SalonBoard's batch shift form can replace the entire day and remove existing
-- todo blocks.  After every terminal shift attempt (including a partial failure),
-- recheck the month's KIREIDOT business blocks. Exact matches are idempotent;
-- only missing blocks are recreated by the worker.
create or replace function public.salonboard_recheck_blocks_after_shift_write()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.job_type <> 'push_shifts'
     or new.status not in ('succeeded', 'failed')
     or new.status is not distinct from old.status
     or coalesce(new.payload->>'month', '') !~ '^[0-9]{6}$'
  then
    return new;
  end if;

  insert into public.salonboard_sync_jobs
    (shop_id, organization_id, job_type, priority, run_at, max_attempts, payload)
  select b.shop_id,
         c.organization_id,
         'push_booking',
         30,
         greatest(
           now() + interval '8 seconds',
           coalesce(c.blocked_until, now()),
           coalesce(c.write_cooldown_until, now())
         ),
         10,
         jsonb_build_object(
           'booking_id', b.id,
           'action', 'create',
           'preflight_required', true,
           'reason', 'recheck_after_shift_write'
         )
    from public.bookings b
    join public.salonboard_credentials c on c.shop_id = b.shop_id
   where b.shop_id = new.shop_id
     and b.booking_type = 'block'
     and b.status::text not in ('cancelled', 'no_show')
     and to_char(b.scheduled_at at time zone 'Asia/Tokyo', 'YYYYMM') = new.payload->>'month'
     and c.enabled is true
     and c.sync_push_enabled is true
     and (
       not (new.payload ? 'staff_ids')
       or b.staff_id::text in (
         select jsonb_array_elements_text(new.payload->'staff_ids')
       )
     )
     and not exists (
       select 1
         from public.salonboard_sync_jobs active
        where active.shop_id = b.shop_id
          and active.job_type = 'push_booking'
          and active.status in ('queued', 'scheduled', 'running')
          and active.payload->>'booking_id' = b.id::text
     );

  return new;
exception when others then
  return new;
end;
$$;

drop trigger if exists salonboard_sync_jobs_recheck_blocks_after_shift_write
  on public.salonboard_sync_jobs;
create trigger salonboard_sync_jobs_recheck_blocks_after_shift_write
after update of status on public.salonboard_sync_jobs
for each row execute function public.salonboard_recheck_blocks_after_shift_write();

revoke all on function public.salonboard_recheck_blocks_after_shift_write() from public;

-- Repair the currently accumulated drift generically. This does not hardcode a
-- customer/shop/staff ID and only queues edits newer than their last confirmed push.
select public.salonboard_enqueue_pending_shift_catchup(
  c.shop_id,
  'migration_repair_unsynced_shift_edits'
)
from public.salonboard_credentials c
where c.enabled is true
  and c.sync_push_enabled is true;
