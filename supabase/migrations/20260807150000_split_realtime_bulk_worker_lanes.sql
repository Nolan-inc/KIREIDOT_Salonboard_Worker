-- 機能要望 2026-08-07: サロンボード取得タスクのワーカー分割 (負荷・障害影響の分離)。
-- 常時系 (予約管理: fetch_bookings / fetch_booking_detail / 各種書込) と
-- 一括系 (シフト/スタイル/メニュー等のまとめ取り fetch) を物理的に別のワーカーで
-- 実行できるよう、claim にレーンフィルタ p_lane ('realtime' | 'bulk' | null=全レーン) を追加する。
--
-- - p_lane 未指定 (既存 Admin / FB ワーカー / PC) は従来どおり全ジョブ対象 = 挙動不変。
-- - アカウント単位の排他 (running_lanes) は全ワーカー横断で従来どおり効くため、
--   分割後も同一SBアカウントの同時セッションは発生しない。
-- - worker は WORKER_CAPABILITIES に 'lane_realtime' / 'lane_bulk' を申告し、
--   Admin /api/salonboard/jobs が p_lane へマップする。

-- ジョブ種別 → レーン分類。
-- bulk     = まとめ取り fetch (シフト/スタイル/メニュー/クーポン/口コミ等) + DOM調査。
--            新規の fetch_* ジョブ種別は既定で bulk に落ちる (予約管理系だけ明示除外)。
-- realtime = 予約管理の常時系 (予約取込/詳細取込) と全書込 (ユーザー操作SLA対象)。
create or replace function public.salonboard_job_lane(p_job_type text)
returns text
language sql
immutable
as $$
  select case
    when p_job_type = 'discover_listing' then 'bulk'
    when p_job_type like 'fetch%'
         and p_job_type not in ('fetch_bookings', 'fetch_booking_detail')
      then 'bulk'
    else 'realtime'
  end;
$$;

-- 引数追加のため作り直す (CREATE OR REPLACE は引数リスト変更不可)。
-- 旧4引数の named-param 呼び出しは新関数の default で解決される。
drop function if exists public.salonboard_claim_next_job(text, integer, integer, text);

create or replace function public.salonboard_claim_next_job(
  p_worker_id text,
  p_limit integer default 1,
  p_lease_seconds integer default 300,
  p_executor text default null,
  p_lane text default null
)
returns setof salonboard_sync_jobs
language plpgsql
as $function$
declare
  v_fetch_cap int := 5;
  v_running_fetch int := 0;
  v_lane_hold_secs int := greatest(p_lease_seconds, 1200);
begin
  if p_worker_id = any (public.salonboard_blocked_worker_ids()) then
    return;
  end if;

  select count(*) into v_running_fetch
  from public.salonboard_sync_jobs j
  where j.status = 'running' and j.locked_at is not null
    and j.locked_at > now() - make_interval(secs => p_lease_seconds)
    and j.job_type like 'fetch%';

  return query
  with running_lanes as (
    select distinct coalesce(cr.group_account_id::text, j.shop_id::text, 'j:' || j.id::text) as lane
    from public.salonboard_sync_jobs j
    left join public.salonboard_credentials cr on cr.shop_id = j.shop_id
    where j.status = 'running' and j.locked_at is not null
      and j.locked_at > now() - make_interval(secs => v_lane_hold_secs)
  ),
  write_lanes as (
    select distinct coalesce(cr.group_account_id::text, j.shop_id::text, 'j:' || j.id::text) as lane
    from public.salonboard_sync_jobs j
    left join public.salonboard_credentials cr on cr.shop_id = j.shop_id
    where j.status = 'queued' and j.run_at <= now()
      and j.job_type in ('push_booking', 'cancel_booking')
  ),
  ranked as (
    select j.id,
      row_number() over (partition by coalesce(cr.group_account_id::text, j.shop_id::text, 'j:' || j.id::text)
        order by (case when j.job_type in ('push_booking','cancel_booking') then 0
                       when j.job_type like 'fetch%' then 2 else 1 end),
                 j.priority asc, j.run_at asc) as rn
    from public.salonboard_sync_jobs j
    left join public.salonboard_credentials cr on cr.shop_id = j.shop_id
    where j.status = 'queued' and j.run_at <= now()
      and (j.locked_at is null or j.locked_at < now() - make_interval(secs => p_lease_seconds))
      and (p_executor is null or j.executor = p_executor)
      and (p_lane is null or public.salonboard_job_lane(j.job_type) = p_lane)
      and (cr.blocked_until is null or cr.blocked_until <= now())
      and (public.salonboard_job_type_feature(j.job_type) is null
           or public.salonboard_feature_allowed(j.shop_id, j.organization_id,
                public.salonboard_job_type_feature(j.job_type),
                public.salonboard_job_type_direction(j.job_type)))
      and coalesce(cr.group_account_id::text, j.shop_id::text, 'j:' || j.id::text) not in (select lane from running_lanes)
      and not (j.job_type like 'fetch%'
               and coalesce(cr.group_account_id::text, j.shop_id::text, 'j:' || j.id::text) in (select lane from write_lanes))
  ),
  cand as (
    select j.id, j.job_type, j.priority, j.run_at,
      case when j.job_type like 'fetch%'
        then row_number() over (partition by (j.job_type like 'fetch%') order by j.priority asc, j.run_at asc)
        else 0 end as fetch_seq
    from public.salonboard_sync_jobs j
    where j.id in (select id from ranked where rn = 1)
  ),
  allowed as (
    select id from cand
    where not (job_type like 'fetch%' and (v_running_fetch + fetch_seq) > v_fetch_cap)
  ),
  picked as (
    select j.id from public.salonboard_sync_jobs j
    where j.id in (select id from allowed)
    order by (case when j.job_type in ('push_booking','cancel_booking') then 0
                   when j.job_type like 'fetch%' then 2 else 1 end),
             j.priority asc, j.run_at asc
    limit p_limit for update skip locked
  )
  update public.salonboard_sync_jobs j
  set status='running', locked_at=now(), locked_by=p_worker_id,
      started_at=coalesce(j.started_at, now()), attempts=j.attempts+1, updated_at=now()
  from picked where j.id = picked.id
  returning j.*;
end;
$function$;

-- DROP/CREATE で ACL が既定 (PUBLIC execute) に戻るため、旧関数と同じ
-- 「service_role のみ実行可」へ明示的に戻す ([[supabase-mcp-migration-grants]] の教訓)。
revoke execute on function public.salonboard_claim_next_job(text, integer, integer, text, text) from public, anon, authenticated;
grant execute on function public.salonboard_claim_next_job(text, integer, integer, text, text) to service_role;

notify pgrst, 'reload schema';
