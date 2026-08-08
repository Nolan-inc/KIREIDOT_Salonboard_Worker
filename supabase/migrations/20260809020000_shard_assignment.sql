-- 店舗シャード分割 Layer1 (docs/scaling-plan.md §4.5)
--
-- 目的: 店舗が増えてもワーカー箱を足すだけで水平に伸ばせるようにする。
--   ・shard は「SBアカウント集合」の論理分割 (店舗ではなくアカウント単位)。
--     同一SBアカウントは同時1セッションしか張れないため、分割の最小単位が
--     アカウント (group_account_id、単独店は shop_id) になる。
--   ・claim に p_shard を足し、worker は capabilities "shard_N" で申告する。
--   ・新店舗は連携開始時に最少負荷 shard へ自動割当 (インフラ作業ゼロ)。
--
-- 後方互換 (最重要):
--   ・shard を1つも定義しなければ従来と完全に同じ挙動 (全workerが全店舗を拾う)。
--   ・p_shard を渡さない worker (未申告/FB/PC) は従来どおり全店舗が対象。
--   ・shard 未割当のアカウントは「どの shard の worker でも拾える」。
--     → 移行期にジョブが宙に浮かない安全弁。割当漏れ = 停止 にはならない。

create table if not exists public.salonboard_worker_shards (
  shard_id   int primary key,
  name       text not null,
  capacity   int not null default 25,   -- 目安の収容アカウント数 (割当の重み付けに使う)
  enabled    boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.salonboard_shard_assignments (
  -- アカウントキー: group_account_id::text (グループ店) or shop_id::text (単独店)
  account_key text primary key,
  shard_id    int not null references public.salonboard_worker_shards(shard_id),
  assigned_at timestamptz not null default now(),
  note        text
);

create index if not exists idx_shard_assignments_shard
  on public.salonboard_shard_assignments(shard_id);

-- service_role 経由で読み書きするため明示GRANT (MCP migrationのGRANT罠対策)
grant select, insert, update, delete on public.salonboard_worker_shards to service_role;
grant select, insert, update, delete on public.salonboard_shard_assignments to service_role;
grant select on public.salonboard_worker_shards to authenticated;
grant select on public.salonboard_shard_assignments to authenticated;

-- アカウントキーの解決 (claim/割当で共通利用)
create or replace function public.salonboard_account_key(p_shop_id uuid)
returns text
language sql
stable
as $function$
  select coalesce(
    (select cr.group_account_id::text
       from public.salonboard_credentials cr
      where cr.shop_id = p_shop_id
      limit 1),
    p_shop_id::text);
$function$;

-- 最少負荷 shard へ割り当てる (冪等: 既に割当済みならそれを返す)。
-- shard が未定義なら null を返し「割当なし = 全workerが対象」のままにする。
create or replace function public.salonboard_assign_shard(p_shop_id uuid)
returns int
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_key text;
  v_shard int;
begin
  if p_shop_id is null then return null; end if;
  v_key := public.salonboard_account_key(p_shop_id);

  select shard_id into v_shard
  from public.salonboard_shard_assignments
  where account_key = v_key;
  if v_shard is not null then
    return v_shard;
  end if;

  -- 収容率 (割当済み/capacity) が最も低い shard を選ぶ
  select s.shard_id into v_shard
  from public.salonboard_worker_shards s
  left join public.salonboard_shard_assignments a on a.shard_id = s.shard_id
  where s.enabled
  group by s.shard_id, s.capacity
  order by (count(a.account_key)::numeric / nullif(s.capacity, 0)) asc nulls first, s.shard_id asc
  limit 1;

  if v_shard is null then
    return null;  -- shard未定義 = 分割していない運用
  end if;

  insert into public.salonboard_shard_assignments(account_key, shard_id, note)
  values (v_key, v_shard, 'auto-assigned on first job/credential')
  on conflict (account_key) do nothing;

  return (select shard_id from public.salonboard_shard_assignments where account_key = v_key);
end;
$function$;

-- 認証情報の登録/更新時に自動割当 (店舗オンボードでインフラ作業を発生させない)
create or replace function public.salonboard_credentials_assign_shard()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  perform public.salonboard_assign_shard(new.shop_id);
  return new;
end;
$function$;

drop trigger if exists trg_salonboard_credentials_assign_shard on public.salonboard_credentials;
create trigger trg_salonboard_credentials_assign_shard
after insert or update of group_account_id, enabled on public.salonboard_credentials
for each row execute function public.salonboard_credentials_assign_shard();

-- claim に p_shard を追加。shard条件は以下のいずれかを満たす行だけを対象にする:
--   1. p_shard 未指定 (従来どおり全店舗)
--   2. そのアカウントが p_shard に割当済み
--   3. そのアカウントがどの shard にも未割当 (移行期の安全弁)
create or replace function public.salonboard_claim_next_job(
  p_worker_id text,
  p_limit integer default 1,
  p_lease_seconds integer default 300,
  p_executor text default null::text,
  p_lane text default null::text,
  p_shard integer default null::integer
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
      -- ★shard 条件 (未指定/割当一致/未割当 のいずれか)
      and (
        p_shard is null
        or exists (
          select 1 from public.salonboard_shard_assignments sa
          where sa.account_key = coalesce(cr.group_account_id::text, j.shop_id::text)
            and sa.shard_id = p_shard
        )
        or not exists (
          select 1 from public.salonboard_shard_assignments sa2
          where sa2.account_key = coalesce(cr.group_account_id::text, j.shop_id::text)
        )
      )
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

-- shard の充足状況を見るビュー (容量ウォッチャー Layer3 / 運用確認用)
create or replace view public.salonboard_shard_load as
select
  s.shard_id,
  s.name,
  s.capacity,
  s.enabled,
  count(a.account_key) as accounts,
  round(count(a.account_key)::numeric / nullif(s.capacity, 0), 2) as load_ratio
from public.salonboard_worker_shards s
left join public.salonboard_shard_assignments a on a.shard_id = s.shard_id
group by s.shard_id, s.name, s.capacity, s.enabled;

grant select on public.salonboard_shard_load to service_role, authenticated;

notify pgrst, 'reload schema';
