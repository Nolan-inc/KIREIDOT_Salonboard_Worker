-- Keep the canonical staff mapping aligned with the latest SalonBoard staff import.
-- A stale staff.salonboard_external_id makes SalonBoard reject booking/schedule writes
-- with KPCL017V01 even when the optimistic-lock token itself is current.

create or replace function public.sync_staff_salonboard_external_id_from_import()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  target_staff_id uuid;
  current_external_id text;
begin
  target_staff_id := new.matched_staff_id;
  if target_staff_id is null then
    return new;
  end if;

  select i.external_id
    into current_external_id
  from public.salonboard_staff_imports i
  where i.matched_staff_id = target_staff_id
    and nullif(btrim(i.external_id), '') is not null
  order by
    i.is_published desc nulls last,
    i.last_synced_at desc nulls last,
    i.updated_at desc nulls last,
    i.created_at desc
  limit 1;

  if current_external_id is not null then
    update public.staff s
       set salonboard_external_id = current_external_id,
           updated_at = now()
     where s.id = target_staff_id
       and s.salonboard_external_id is distinct from current_external_id;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_sync_staff_salonboard_external_id_from_import
  on public.salonboard_staff_imports;

create trigger trg_sync_staff_salonboard_external_id_from_import
after insert or update of external_id, matched_staff_id, is_published, last_synced_at
on public.salonboard_staff_imports
for each row
execute function public.sync_staff_salonboard_external_id_from_import();

-- Repair existing stale mappings. Published staff are authoritative; otherwise use
-- the most recently synchronized import for that matched KIREIDOT staff.
with ranked as (
  select
    i.matched_staff_id,
    i.external_id,
    row_number() over (
      partition by i.matched_staff_id
      order by
        i.is_published desc nulls last,
        i.last_synced_at desc nulls last,
        i.updated_at desc nulls last,
        i.created_at desc
    ) as rn
  from public.salonboard_staff_imports i
  where i.matched_staff_id is not null
    and nullif(btrim(i.external_id), '') is not null
)
update public.staff s
   set salonboard_external_id = r.external_id,
       updated_at = now()
  from ranked r
 where r.rn = 1
   and r.matched_staff_id = s.id
   and s.salonboard_external_id is distinct from r.external_id;

