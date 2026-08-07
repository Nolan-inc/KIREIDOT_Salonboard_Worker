-- アカウント冷却(CAPTCHA)中の予約系/シフト書込を毎分PCレーンへ移管する。
-- 冷却(blocked_until)中のジョブはclaimされないため、callback側の即PC移管
-- (Admin PR#85=失敗時発火)に到達せず、キューで冷却明けを待って予約SLAを割る
-- (2026-08-08未明: 54件が滞留しcreate平均35分)。claim前の滞留をここで拾う。
-- PC(予約同期くん)死活は salonboard_pc_available() で判定し、不応答時は移管しない。
create or replace function public.salonboard_reroute_cooldown_writes_to_pc()
 returns integer
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare v_count integer := 0;
begin
  if not public.salonboard_pc_available() then
    return 0;
  end if;
  update public.salonboard_sync_jobs j set
    executor = 'playwright',
    run_at = now(),
    attempts = 0,
    payload = coalesce(j.payload, '{}'::jsonb) || jsonb_build_object('pc_fallback','true'),
    error = '[LOGIN_COOLDOWN_PC_REROUTE] アカウント冷却(CAPTCHA)中のためPCへ移管: ' || coalesce(j.error, '')
  from public.salonboard_credentials c
  where j.shop_id = c.shop_id
    and j.status = 'queued'
    and j.executor in ('playwright_cloud', 'fallback_cloud')
    and j.job_type in ('push_booking', 'cancel_booking', 'push_shifts')
    and c.blocked_until > now()
    and coalesce(j.payload->>'pc_fallback', '') <> 'true';
  get diagnostics v_count = row_count;
  return v_count;
end;
$function$;

create or replace function public.salonboard_sync_maintenance()
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
begin
  perform public.salonboard_reap_read_jobs();
  perform public.salonboard_reap_write_jobs();
  perform public.salonboard_reap_stale_queued_writes();
  perform public.salonboard_reap_shift_blocked_bookings();   -- ★shift未整合の実失敗をmanual_requiredへ
  perform public.salonboard_auto_match_shift_patterns();
  perform public.salonboard_reroute_cooldown_writes_to_pc(); -- ★冷却中の予約系はPCへ (3分SLA)
  perform public.salonboard_detect_stalls();
  perform public.salonboard_reenqueue_orphans();
  perform public.salonboard_invoke_ops_alert();
end;
$function$;
