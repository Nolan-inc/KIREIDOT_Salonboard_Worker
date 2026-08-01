-- Recheck every business block from the dates reported in the 2026-08-01
-- Yoyogi-Uehara incident. Exact verification makes already-correct rows no-op;
-- missing rows are recreated without duplicating the shop's manual corrections.
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
         'reason', 'reported_business_block_recheck'
       )
  from public.bookings b
  join public.shops sh on sh.id = b.shop_id
  join public.salonboard_credentials c on c.shop_id = b.shop_id
 where sh.name = 'Une limit 代々木上原店 【アンリミット】'
   and b.booking_type = 'block'
   and b.status::text not in ('cancelled', 'no_show')
   and (b.scheduled_at at time zone 'Asia/Tokyo')::date in (
     date '2026-08-14',
     date '2026-08-20'
   )
   and c.enabled is true
   and c.sync_push_enabled is true
   and not exists (
     select 1
       from public.salonboard_sync_jobs active
      where active.shop_id = b.shop_id
        and active.job_type = 'push_booking'
        and active.status in ('queued', 'scheduled', 'running')
        and active.payload->>'booking_id' = b.id::text
   );
