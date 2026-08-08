-- 【ドラフト・未適用】店舗シャード分割(scaling-plan §4.5 Layer1)
-- 適用タイミング: 25店舗超 or 予約p95が3分接近時(Step1)。適用時は
-- supabase/migrations/ へ日付付きで移してから apply すること。
--
-- 設計:
--  - shard は「SBアカウント集合」の論理分割。店舗ではなくアカウント
--    (group_account_id または単独shopのshop_id)単位で割り当てる
--  - claim に p_shard を追加(null=全shard: 後方互換)。worker は
--    capabilities "shard_1" 等で申告し、Admin jobs API が p_shard に変換
--  - 新店舗は連携開始時に最少負荷shardへ自動割当(手作業ゼロ)

-- 1) shard定義
create table if not exists public.salonboard_worker_shards (
  shard_id   int primary key,
  name       text not null,
  capacity   int not null default 25,           -- 目安収容アカウント数
  created_at timestamptz not null default now()
);

-- 2) アカウント→shard割当(アカウントキー= group_account_id::text or shop_id::text)
create table if not exists public.salonboard_shard_assignments (
  account_key text primary key,
  shard_id    int not null references public.salonboard_worker_shards(shard_id),
  assigned_at timestamptz not null default now()
);
-- service_role 経由アクセスのため明示GRANT(MCP migrationのGRANT罠対策)
grant select, insert, update, delete on public.salonboard_worker_shards to service_role;
grant select, insert, update, delete on public.salonboard_shard_assignments to service_role;

-- 3) アカウントキー解決ヘルパ
create or replace function public.salonboard_account_key(p_shop_id uuid)
returns text language sql stable as $$
  select coalesce(
    (select cr.group_account_id::text from public.salonboard_credentials cr where cr.shop_id = p_shop_id),
    p_shop_id::text);
$$;

-- 4) 最少負荷shardへの自動割当(連携開始トリガ or credentials INSERTトリガから呼ぶ)
create or replace function public.salonboard_assign_shard(p_shop_id uuid)
returns int language plpgsql as $$
declare v_key text; v_shard int;
begin
  v_key := public.salonboard_account_key(p_shop_id);
  select shard_id into v_shard from public.salonboard_shard_assignments where account_key = v_key;
  if v_shard is not null then return v_shard; end if;
  select s.shard_id into v_shard
  from public.salonboard_worker_shards s
  left join public.salonboard_shard_assignments a on a.shard_id = s.shard_id
  group by s.shard_id, s.capacity
  order by count(a.account_key)::float / nullif(s.capacity,0) asc, s.shard_id asc
  limit 1;
  if v_shard is null then return null; end if; -- shard未定義なら割当なし(=全workerが対象)
  insert into public.salonboard_shard_assignments(account_key, shard_id)
  values (v_key, v_shard) on conflict (account_key) do nothing;
  return v_shard;
end $$;

-- 5) claim拡張(適用時に salonboard_claim_next_job へ p_shard int default null を追加し、
--    ranked CTE の where に以下を足す):
--   and (p_shard is null
--        or exists (select 1 from public.salonboard_shard_assignments a
--                   where a.account_key = coalesce(cr.group_account_id::text, j.shop_id::text)
--                     and a.shard_id = p_shard)
--        or not exists (select 1 from public.salonboard_shard_assignments a2
--                   where a2.account_key = coalesce(cr.group_account_id::text, j.shop_id::text)))
--   ※未割当アカウントはどのshardのworkerでも拾える(移行期の安全弁)
--
-- 6) Admin jobs API: caps の 'shard_<n>' を p_shard へ変換(lane変換と同じ箇所)
-- 7) worker: capabilities ファイルに shard_1 等を追記するだけ(ホット設定)
