-- Normalize legacy booking snapshots that retained the previous staff after a
-- KIREIDOT reassignment. Re-submit only future, already-created SalonBoard
-- reservations; historical rows are corrected in-place without a write storm.
with candidates as (
  select b.id,
         (
           (
             nullif(btrim(coalesce(b.salonboard_staff_external_id, '')), '') is not null
             and b.salonboard_staff_external_id is distinct from nullif(btrim(s.salonboard_external_id), '')
           )
           or (
             nullif(btrim(coalesce(b.salonboard_staff_name, '')), '') is not null
             and public.resolve_salonboard_staff_id(b.shop_id, b.salonboard_staff_name) is not null
             and public.resolve_salonboard_staff_id(b.shop_id, b.salonboard_staff_name) <> b.staff_id
           )
         ) as staff_was_mismatched
    from public.bookings b
    join public.staff s on s.id = b.staff_id
   where b.salonboard_staff_external_id is distinct from nullif(btrim(s.salonboard_external_id), '')
      or b.salonboard_staff_name is distinct from nullif(btrim(s.full_name), '')
), changed as (
  update public.bookings b
     set salonboard_staff_external_id = nullif(btrim(s.salonboard_external_id), ''),
         salonboard_staff_name = nullif(btrim(s.full_name), ''),
         updated_at = coalesce(b.updated_at, now())
    from public.staff s, candidates candidate
   where s.id = b.staff_id
     and candidate.id = b.id
  returning b.id, b.shop_id, b.scheduled_at, b.status::text as booking_status,
            b.external_booking_id, candidate.staff_was_mismatched
), queued as (
  insert into public.salonboard_sync_jobs
    (shop_id, organization_id, job_type, priority, run_at, max_attempts, payload)
  select ch.shop_id,
         c.organization_id,
         'push_booking',
         2,
         greatest(
           now() + interval '8 seconds',
           coalesce(c.blocked_until, now()),
           coalesce(c.write_cooldown_until, now())
         ),
         3,
         jsonb_build_object(
           'booking_id', ch.id,
           'action', 'update',
           'reason', 'canonical_staff_identity_backfill'
         )
    from changed ch
    join public.salonboard_credentials c on c.shop_id = ch.shop_id
   where ch.scheduled_at >= date_trunc('day', now() at time zone 'Asia/Tokyo') at time zone 'Asia/Tokyo'
     and ch.staff_was_mismatched is true
     and ch.booking_status not in ('cancelled', 'no_show')
     and nullif(btrim(coalesce(ch.external_booking_id, '')), '') is not null
     and c.enabled is true
     and c.sync_push_enabled is true
     and not exists (
       select 1
         from public.salonboard_sync_jobs active
        where active.shop_id = ch.shop_id
          and active.job_type = 'push_booking'
          and active.status in ('queued', 'scheduled', 'running')
          and active.payload->>'booking_id' = ch.id::text
     )
  returning (payload->>'booking_id')::uuid as booking_id
)
update public.bookings b
   set salonboard_sync_status = 'pending_push',
       salonboard_last_push_error = null
 where b.id in (select q.booking_id from queued q);
