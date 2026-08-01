-- Include currently running repair jobs so a retry keeps the lower precedence.
update public.salonboard_sync_jobs
set priority = greatest(priority, 200),
    updated_at = now()
where status in ('queued', 'running')
  and job_type = 'push_booking'
  and payload->>'reason' = 'recheck_after_shift_write';
