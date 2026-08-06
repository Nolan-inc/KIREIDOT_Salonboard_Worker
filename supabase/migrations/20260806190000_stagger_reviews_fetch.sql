-- fetch_reviews だけ他の設定系fetchより15分遅らせる。
-- 夜間03:00 cron は同一店舗の10種fetchを同時刻に積み、claim順は不定。コールド
-- セッションの一発目を fetch_reviews が引くと、グループアカウント(ADER/GINA)では
-- 店舗文脈確立に失敗し3時間リトライで全滅する(8/2以降毎晩・過去の「成功」も
-- 大半は期限切れページを0件成功として読んでいた)。menu/coupon 等が先に走って
-- セッションを温めた後なら reviews も成功する(単独店なんば03:20成功・歴代の
-- 実取得成功も warm セッション時のみ)ため、reviews を各店の他fetchの後段に固定する。
create or replace function public.salonboard_enqueue_cloud_settings_fetch()
 returns integer
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare v_count integer := 0;
begin
  insert into public.salonboard_sync_jobs (shop_id, organization_id, job_type, priority, payload, executor, run_at)
  select c.shop_id, s.organization_id, j.jt, 7, '{}'::jsonb, 'playwright_cloud',
         -- 店舗ごとに10分刻み+2分jitterで分散。同一店舗の10種は同時刻(1ログインで連続fetch)。
         -- ただし fetch_reviews のみ +15分: コールドセッションの一発目を引かせない。
         now() + (o.shop_rank * interval '10 minutes') + (o.jitter * interval '2 minutes')
             + (case when j.jt = 'fetch_reviews' then interval '15 minutes' else interval '0 minutes' end)
  from public.salonboard_credentials c
  join public.shops s on s.id = c.shop_id
  join lateral (
    select rank.rn - 1 as shop_rank, random() as jitter
    from (
      select c2.shop_id, row_number() over (order by c2.shop_id) as rn
      from public.salonboard_credentials c2
      where c2.enabled = true and c2.sync_fetch_enabled = true and c2.cloud_fetch_enabled = true
    ) rank
    where rank.shop_id = c.shop_id
  ) o on true
  cross join (values ('fetch_staff'),('fetch_menu'),('fetch_coupon'),('fetch_equipment'),
                     ('fetch_reviews'),('fetch_blog'),('fetch_photo_gallery'),('fetch_salon'),
                     ('fetch_kodawari'),('fetch_feature')) as j(jt)
  where c.enabled = true and c.sync_fetch_enabled = true and c.cloud_fetch_enabled = true
    and (c.blocked_until is null or c.blocked_until <= now())
    and not exists (
      select 1 from public.salonboard_sync_jobs k
      where k.shop_id = c.shop_id and k.job_type = j.jt
        and k.executor = 'playwright_cloud' and k.status = 'queued');
  get diagnostics v_count = row_count;
  return v_count;
end;
$function$;
