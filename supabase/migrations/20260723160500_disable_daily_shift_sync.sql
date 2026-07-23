-- Shift writes are event-driven from KIREIDOT edits.  The former daily full-month
-- sweep created unnecessary SalonBoard writes and could race with booking writes.

do $$
begin
  perform cron.unschedule('salonboard-daily-shift-sync-enqueue');
exception when others then
  null;
end;
$$;

do $$
begin
  perform cron.unschedule('salonboard-daily-shift-sync-report');
exception when others then
  null;
end;
$$;

create or replace function public.salonboard_enqueue_daily_shift_sync()
returns integer
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Deliberate no-op. Keep the function for compatibility with any stale caller.
  return 0;
end;
$$;

create or replace function public.run_salonboard_shift_sync_report()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  -- The daily enqueue is disabled, so there is no daily report to send.
  return;
end;
$$;

update public.salonboard_sync_jobs
set status = 'cancelled',
    error = '[DAILY_SHIFT_SYNC_DISABLED] 日次全月シフト反映を廃止しました。KD編集時の差分反映を使用します。',
    locked_at = null,
    locked_by = null,
    completed_at = coalesce(completed_at, now()),
    updated_at = now()
where job_type = 'push_shifts'
  and payload->>'reason' = 'daily_shift_sync'
  and status = 'queued';
