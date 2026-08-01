-- The shift-repair backfill is best-effort reconciliation. Keep genuine booking
-- writes ahead of it so a large repair batch cannot delay newly created jobs.
update public.salonboard_sync_jobs
set priority = greatest(priority, 200),
    updated_at = now()
where status = 'queued'
  and job_type = 'push_booking'
  and payload->>'reason' = 'recheck_after_shift_write';
