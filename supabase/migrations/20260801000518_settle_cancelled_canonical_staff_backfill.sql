-- The first production backfill was deliberately stopped after scope validation:
-- formatting-only name differences must not trigger external writes. Restore the
-- local sync marker for those cancelled jobs while keeping real active writes intact.
update public.bookings b
   set salonboard_sync_status = 'synced',
       salonboard_last_push_error = null
 where exists (
   select 1
     from public.salonboard_sync_jobs stopped
    where stopped.payload->>'booking_id' = b.id::text
      and stopped.payload->>'reason' = 'canonical_staff_identity_backfill'
      and stopped.status = 'cancelled'
      and stopped.error like '[CANONICAL_STAFF_BACKFILL_SCOPE_REDUCED]%'
 )
   and not exists (
     select 1
       from public.salonboard_sync_jobs active
      where active.payload->>'booking_id' = b.id::text
        and active.job_type in ('push_booking', 'cancel_booking')
        and active.status in ('queued', 'scheduled', 'running')
   );
