-- The Admin jobs API exposes cancel data from payload.snapshot to workers.
-- Mirror the proven-never-synced marker into that snapshot for historical
-- jobs as well as the top-level payload marker added by the prior migration.
update public.salonboard_sync_jobs cancelled
   set payload = jsonb_set(
     coalesce(cancelled.payload, '{}'::jsonb),
     '{snapshot}',
     coalesce(cancelled.payload->'snapshot', '{}'::jsonb)
       || jsonb_build_object('assume_absent_if_never_synced', true),
     true
   ) || jsonb_build_object('assume_absent_if_never_synced', true)
 where cancelled.job_type = 'cancel_booking'
   and nullif(btrim(coalesce(cancelled.payload#>>'{snapshot,external_booking_id}', '')), '') is null
   and cancelled.payload ? 'booking_id'
   and not exists (
     select 1
       from public.salonboard_sync_jobs pushed
      where pushed.job_type = 'push_booking'
        and pushed.status = 'succeeded'
        and pushed.payload->>'booking_id' = cancelled.payload->>'booking_id'
   );
