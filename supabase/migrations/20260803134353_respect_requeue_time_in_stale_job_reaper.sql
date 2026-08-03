-- A deliberately requeued historical job has an old created_at but a fresh
-- updated_at/run_at. Treat the latest lifecycle timestamp as its age so the
-- three-minute maintenance cron cannot immediately fail a valid retry.
create or replace function public.salonboard_reap_stale_queued_writes(
  p_max_age_hours integer default 24,
  p_unwinnable_min_attempts integer default 3
)
returns integer
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_n integer;
begin
  with reaped as (
    update public.salonboard_sync_jobs j
    set status = 'failed',
        completed_at = now(),
        locked_at = null,
        locked_by = null,
        error = left(
          coalesce(j.error, '') ||
          case
            when j.attempts >= j.max_attempts
              then ' [自動終了: 最大再試行回数に到達。要手動対応]'
            when greatest(j.created_at, j.updated_at, j.run_at)
                 < now() - make_interval(hours => p_max_age_hours)
              then ' [自動終了: ' || p_max_age_hours || '時間以上滞留(orphan)。要手動対応]'
            else ' [自動終了: 再試行で解決しないエラー(受付可能数超過/予定重複/SB予約ID無し)。要手動対応]'
          end,
          1000
        ),
        updated_at = now()
    where j.status = 'queued'
      and j.run_at <= now()
      and j.job_type in (
        'push_booking', 'cancel_booking', 'push_shifts', 'push_blog',
        'delete_blog', 'push_photo_gallery', 'delete_photo_gallery',
        'push_review_reply'
      )
      and (
        j.attempts >= j.max_attempts
        or greatest(j.created_at, j.updated_at, j.run_at)
           < now() - make_interval(hours => p_max_age_hours)
        or (
          j.attempts >= p_unwinnable_min_attempts
          and j.error ~ '受付可能数|予定重複|特定できません|external_booking_id'
        )
      )
    returning j.id
  )
  select count(*) into v_n from reaped;

  return v_n;
end;
$function$;

revoke all on function public.salonboard_reap_stale_queued_writes(integer, integer)
  from public, anon, authenticated;
