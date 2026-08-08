-- レーン再分類: 常時系(realtime)を「予約系SLA対象」に純化する。
-- 従来: fetch系(bookings除く)のみbulk。設定書込(menu/coupon/staff/shift等)・投稿
-- (photo/blog)・シフト反映がrealtimeに残っており、2026-08-08のクーポン一括再実行
-- (434件)が予約書込と同じ箱/レーンを奪い合った。
-- 変更後:
--   realtime = push_booking / cancel_booking / push_acceptance / *booking*(fetch_bookings,
--              fetch_booking_detail) / *staff_resolution*(予約担当解決)
--   bulk     = それ以外すべて(設定書込・投稿・設定fetch・discover等)。未知の新job_typeも
--              既定bulk(SLAレーンを汚さない安全側)
-- 箱跨ぎの同一アカウント衝突は claim の running_lanes(group_account_id優先キー)が
-- DBレベルで直列化済みのため、この再分類でセッション奪い合いは発生しない。
create or replace function public.salonboard_job_lane(p_job_type text)
 returns text
 language sql
 immutable
as $function$
  select case
    when p_job_type in ('push_booking', 'cancel_booking', 'push_acceptance')
      or p_job_type like '%booking%'
      or p_job_type like '%staff_resolution%'
      then 'realtime'
    else 'bulk'
  end;
$function$;
