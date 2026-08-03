-- Prevent two workers (for example primary Cloud and Fallback Cloud) from
-- claiming different jobs for the same SalonBoard login lane concurrently.
--
-- The claim functions inspect running rows before updating their candidate,
-- but two transactions can pass that check at the same instant.  Serialize
-- only the short queued -> running transition per account lane, then skip the
-- second transition when another live lease is already present.

create or replace function public.salonboard_guard_account_lane_claim()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_lane text;
begin
  if new.status <> 'running' or old.status = 'running' then
    return new;
  end if;

  select coalesce(c.group_account_id::text, new.shop_id::text)
    into v_lane
  from public.salonboard_credentials c
  where c.shop_id = new.shop_id;

  v_lane := coalesce(v_lane, new.shop_id::text, 'job:' || new.id::text);

  -- Transaction-scoped and lane-specific: unrelated SalonBoard accounts can
  -- still be claimed in parallel.
  perform pg_advisory_xact_lock(
    hashtextextended('salonboard-account-lane:' || v_lane, 0)
  );

  if exists (
    select 1
    from public.salonboard_sync_jobs j
    left join public.salonboard_credentials c on c.shop_id = j.shop_id
    where j.id <> new.id
      and j.status = 'running'
      and j.locked_at is not null
      and j.locked_at > now() - interval '20 minutes'
      and coalesce(c.group_account_id::text, j.shop_id::text, 'job:' || j.id::text) = v_lane
  ) then
    -- Returning null from a BEFORE ROW trigger skips just this candidate.  The
    -- worker receives no claimed row and will poll again after the live lane
    -- is released, without creating a false failure record.
    return null;
  end if;

  return new;
end;
$function$;

drop trigger if exists salonboard_sync_jobs_guard_account_lane_claim
  on public.salonboard_sync_jobs;

create trigger salonboard_sync_jobs_guard_account_lane_claim
before update of status on public.salonboard_sync_jobs
for each row
when (new.status = 'running' and old.status is distinct from 'running')
execute function public.salonboard_guard_account_lane_claim();

comment on function public.salonboard_guard_account_lane_claim() is
  'Serializes queued-to-running transitions per SalonBoard account lane and skips concurrent claims.';
