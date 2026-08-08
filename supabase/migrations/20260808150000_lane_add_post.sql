-- 投稿レーン(post)の追加 — 3レーン体制へ
--
-- レーン定義(2026-08-08):
--   realtime = 予約系SLA対象: push_booking / cancel_booking / push_acceptance /
--              *booking*(fetch_bookings, fetch_booking_detail) / *staff_resolution*
--   post     = 掲載コンテンツの投稿/反映: ブログ・スタイル・フォトギャラリー・
--              クーポン・メニュー(push系)とその取得(fetch系)
--   bulk     = それ以外(スタッフ/設備/シフト/口コミ/こだわり/特集/サロン情報/売上/
--              discover 等)。未知の新job_typeも既定bulk(SLAレーン保護)
--
-- 箱跨ぎの同一アカウント衝突は claim の running_lanes(group_account_id 優先キー)が
-- DBレベルで直列化するため、3箱同時稼働でもSBセッションの奪い合いは起きない。
create or replace function public.salonboard_job_lane(p_job_type text)
 returns text
 language sql
 immutable
as $function$
  select case
    -- 予約系(SLA対象)を最優先で判定
    when p_job_type in ('push_booking', 'cancel_booking', 'push_acceptance')
      or p_job_type like '%booking%'
      or p_job_type like '%staff_resolution%'
      then 'realtime'
    -- 投稿・掲載コンテンツ系
    when p_job_type like '%blog%'
      or p_job_type like '%style%'
      or p_job_type like '%photo%'
      or p_job_type like '%gallery%'
      or p_job_type like '%coupon%'
      or p_job_type like '%menu%'
      then 'post'
    else 'bulk'
  end;
$function$;
