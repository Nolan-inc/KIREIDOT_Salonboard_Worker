-- Fallback Cloud レーン (executor='fallback_cloud') の追加
--
-- 目的: 本体Cloud worker (playwright_cloud) で失敗した書込ジョブを、別EC2の
-- フォールバックworker (fallback_cloud) がリトライできるようにする。
--
-- 連鎖順序: Cloud → Fallback Cloud → 互換PC → failed
--   - PC対応3種 (push_booking/cancel_booking/push_shifts) は互換PC不在時、
--     従来通りCloudレーンで再試行し続ける (予約系を諦めない現行保証を維持)
--   - PC非対応種別は Fallback Cloud が最後の砦 → [FB_CLOUD_EXHAUSTED] で打ち切り
--   - fetch系 / フォト・スタイル投稿 (SB bot対策ホールド) は対象外
--
-- ハンドオフ規約: executor='fallback_cloud' + payload.fallback_cloud=true (1回限り)
--   + preflight_required=true (冪等性: worker既存flagで再検証) + attempts=0
--
-- 不活性設計: 適用直後は salonboard_executor_heartbeats が空 =
-- salonboard_fallback_available()=false のため全分岐no-op。FB workerが
-- capabilities=fallback_cloud でポーリングを開始した時点で自動的に活性化する。

-- ─────────────────────────────────────────────────────────────
-- (a) executor CHECK制約に 'fallback_cloud' を追加
-- ─────────────────────────────────────────────────────────────
alter table public.salonboard_sync_jobs
  drop constraint if exists salonboard_sync_jobs_executor_check;
alter table public.salonboard_sync_jobs
  add constraint salonboard_sync_jobs_executor_check
  check (executor in ('playwright', 'playwright_cloud', 'openclaw', 'fallback_cloud'));

-- ─────────────────────────────────────────────────────────────
-- (b) FB worker死活シグナル
-- salonboard_worker_heartbeats は salonboard_pc_available() が enable_push 行を
-- 数えるため流用禁止 (FB行を入れるとPCゲートが誤ってtrueになる) → 専用テーブル。
-- upsert元は Admin /api/salonboard/jobs route (claim poll毎)。
-- ─────────────────────────────────────────────────────────────
create table if not exists public.salonboard_executor_heartbeats (
  executor text primary key,
  worker_id text,
  last_seen_at timestamptz not null default now()
);
alter table public.salonboard_executor_heartbeats enable row level security;

create or replace function public.salonboard_fallback_available()
returns boolean
language sql
stable security definer
set search_path to 'public'
as $$
  -- worker poll間隔は最大30秒。3分窓で「生きているが忙しい」を殺さない
  select exists (
    select 1
    from public.salonboard_executor_heartbeats
    where executor = 'fallback_cloud'
      and last_seen_at > now() - interval '3 minutes'
  );
$$;
grant execute on function public.salonboard_fallback_available() to service_role;

-- ─────────────────────────────────────────────────────────────
-- (c) salonboard_enforce_cloud_executor: fallback_cloud のpass-through追加
-- このトリガはWHEN句なしの BEFORE INSERT OR UPDATE で全行発火するため、
-- pass-throughがないと fallback_cloud を playwright_cloud に黙って上書きする。
-- ─────────────────────────────────────────────────────────────
create or replace function public.salonboard_enforce_cloud_executor()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  -- フォト/スタイル投稿はPC既定 (画像アップロードのbot対策ホールド回避)
  if new.job_type in ('push_photo_gallery', 'delete_photo_gallery') then
    new.executor := 'playwright';
    return new;
  end if;

  -- Fallback Cloud レーン: 連鎖エンジン/callbackが付けたマーカー付きの行は通す
  if new.executor = 'fallback_cloud'
     and coalesce(new.payload->>'fallback_cloud', 'false') = 'true'
     and new.job_type in (
       'push_booking', 'cancel_booking', 'push_shifts', 'push_blog', 'delete_blog',
       'push_review_reply', 'push_acceptance', 'push_equipment', 'push_staff',
       'push_menu', 'push_coupon', 'push_shift_patterns', 'push_salon',
       'push_kodawari', 'push_feature', 'configure_notice_mail'
     ) then
    return new;
  end if;

  -- Booking/cancel/shift writes may use the guarded compatible-PC fallback
  -- installed by 20260727171841.  All normal inserts/updates remain Cloud-authoritative.
  if coalesce(new.payload->>'pc_fallback', 'false') = 'true'
     and new.executor = 'playwright'
     and new.job_type in ('push_booking', 'cancel_booking', 'push_shifts') then
    return new;
  end if;

  new.executor := 'playwright_cloud';
  new.payload := coalesce(new.payload, '{}'::jsonb)
    - 'pc_fallback'
    - 'pc_fallback_at'
    - 'pc_fallback_from';
  -- fallback_cloudマーカーは新規enqueue時のみ剥がす。UPDATE時に剥がすと
  -- FB枯渇→Cloud再試行の recycle でマーカーが消え、Cloud⇔FBの無限ピンポンになる
  if tg_op = 'INSERT' then
    new.payload := new.payload
      - 'fallback_cloud'
      - 'fallback_cloud_at'
      - 'fallback_cloud_from';
  end if;
  return new;
end;
$function$;

-- ─────────────────────────────────────────────────────────────
-- (d) 連鎖エンジン salonboard_force_cloud_failure_fallback:
--     Cloud枯渇 → FBゲート → PCゲート → 連鎖末端 に多段化
-- ─────────────────────────────────────────────────────────────
create or replace function public.salonboard_force_cloud_failure_fallback()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_should_fallback boolean;
  v_compatible_pc_online boolean := false;
  v_error text;
  v_retry_cycle integer;
  v_latest_attempt_status text;
  v_fb_types constant text[] := array[
    'push_booking', 'cancel_booking', 'push_shifts', 'push_blog', 'delete_blog',
    'push_review_reply', 'push_acceptance', 'push_equipment', 'push_staff',
    'push_menu', 'push_coupon', 'push_shift_patterns', 'push_salon',
    'push_kodawari', 'push_feature', 'configure_notice_mail'
  ];
  v_pc_types constant text[] := array['push_booking', 'cancel_booking', 'push_shifts'];
begin
  if pg_trigger_depth() > 1 then
    return new;
  end if;

  -- ハンドオフUPDATE自身 (→fallback_cloud への移管) を即再ルートしない
  if new.executor = 'fallback_cloud' and old.executor is distinct from 'fallback_cloud' then
    return new;
  end if;

  select wa.status
    into v_latest_attempt_status
    from public.salonboard_write_attempts wa
   where wa.job_id = new.id
   order by wa.created_at desc, wa.id desc
   limit 1;

  v_should_fallback :=
    new.executor in ('playwright_cloud', 'fallback_cloud')
    and new.job_type = any (v_fb_types)
    and v_latest_attempt_status is distinct from 'manual_required'
    -- SBが重複としてPOSTを破棄するデータ起因の衝突は、どのレーンで
    -- 再実行しても同じ結果になるため再投入しない。
    and coalesce(new.error, '') !~
      '予定登録POSTは受理されました|入力された時間帯に別のシフトまたは予定が登録されています'
    and (
      new.status = 'failed'
      or (
        new.status = 'queued'
        and (
          old.attempts >= greatest(old.max_attempts, 3)
          or (
            new.attempts = 0
            and coalesce(new.error, '') ~
              'KPCL017V01|SB_SERVER_ERROR|JOB_TIMEOUT|STALE_LOCK_RETRY_EXHAUSTED'
          )
        )
      )
    );

  if not v_should_fallback then
    return new;
  end if;

  v_error := regexp_replace(
    coalesce(new.error, 'Cloud処理が完了しませんでした'),
    '^\[(CLOUD_PC_FALLBACK|CLOUD_RETRY_NO_COMPATIBLE_PC|CLOUD_FB_FALLBACK|FALLBACK_CLOUD_TIMEOUT|FB_CLOUD_EXHAUSTED)\][^:]*:\s*',
    ''
  );

  -- Stage 1: Cloud → Fallback Cloud (未移管 かつ FB worker生存時)
  if new.executor = 'playwright_cloud'
     and coalesce(new.payload->>'fallback_cloud', 'false') <> 'true'
     and public.salonboard_fallback_available()
  then
    update public.salonboard_sync_jobs
       set status = 'queued',
           executor = 'fallback_cloud',
           payload = (
             coalesce(payload, '{}'::jsonb)
               - 'pc_fallback'
               - 'pc_fallback_at'
               - 'pc_fallback_from'
               - 'pc_fallback_reason'
               - 'pc_fallback_blocked_reason'
           ) || jsonb_build_object(
             'fallback_cloud', true,
             'fallback_cloud_at', now(),
             'fallback_cloud_from', 'playwright_cloud',
             'preflight_required', true
           ),
           attempts = 0,
           max_attempts = greatest(max_attempts, 3),
           run_at = now(),
           completed_at = null,
           locked_at = null,
           locked_by = null,
           error = left(
             '[CLOUD_FB_FALLBACK] Cloudで完了できなかったため予備Cloudで再実行します: '
               || v_error,
             1000
           ),
           updated_at = now()
     where id = new.id;

    return new;
  end if;

  -- Stage 2: → 互換PC (PC対応3種のみ・未PC移管のみ)
  if new.job_type = any (v_pc_types)
     and coalesce(new.payload->>'pc_fallback', 'false') <> 'true'
  then
    select exists (
      select 1
        from public.salonboard_worker_heartbeats h
        cross join lateral regexp_match(
          coalesce(h.app_version, ''),
          '^([0-9]+)\.([0-9]+)\.([0-9]+)'
        ) as parsed(parts)
       where h.is_active is true
         and h.enable_push is true
         -- heartbeat は5分間隔送信。判定窓は salonboard_pc_available() と同じ7分。
         and h.last_seen_at >= now() - interval '7 minutes'
         and (
           parsed.parts[1]::integer,
           parsed.parts[2]::integer,
           parsed.parts[3]::integer
         ) >= (0, 2, 234)
    )
    into v_compatible_pc_online;
  end if;

  if v_compatible_pc_online then
    v_error := replace(
      replace(
        v_error,
        '最新情報からCloudで全工程を再試行します。',
        '互換PCで全工程を再試行します。'
      ),
      '同じCloudで全工程を自動再試行します',
      '互換PCで全工程を再試行します'
    );

    update public.salonboard_sync_jobs
       set status = 'queued',
           executor = 'playwright',
           payload = coalesce(payload, '{}'::jsonb) || jsonb_build_object(
             'pc_fallback', true,
             'pc_fallback_at', now(),
             'pc_fallback_from', new.executor,
             'pc_fallback_reason', 'cloud_retries_exhausted_compatible_pc',
             'preflight_required', true
           ),
           attempts = 0,
           max_attempts = greatest(max_attempts, 3),
           run_at = now(),
           completed_at = null,
           locked_at = null,
           locked_by = null,
           error = left(
             '[CLOUD_PC_FALLBACK] Cloud/予備Cloudで完了できなかったため'
               || '互換PCで再実行します: '
               || v_error,
             1000
           ),
           updated_at = now()
     where id = new.id;

    return new;
  end if;

  -- Stage 3: 連鎖末端
  if new.job_type = any (v_pc_types) then
    -- 予約系3種は諦めない (現行保証の維持): Cloudレーンで再試行し続ける。
    -- FB由来の行は fallback_cloud マーカーを保持したまま戻すため再FB移管はされない。
    v_retry_cycle :=
      case
        when coalesce(new.payload->>'cloud_retry_cycle', '') ~ '^[0-9]+$'
          then (new.payload->>'cloud_retry_cycle')::integer + 1
        else 1
      end;

    update public.salonboard_sync_jobs
       set status = 'queued',
           executor = 'playwright_cloud',
           payload = (
             coalesce(payload, '{}'::jsonb)
               - 'pc_fallback'
               - 'pc_fallback_at'
               - 'pc_fallback_from'
               - 'pc_fallback_reason'
           ) || jsonb_build_object(
             'cloud_retry_cycle', v_retry_cycle,
             'cloud_retry_after_pc_gate_at', now(),
             'pc_fallback_blocked_reason', 'no_compatible_pc_v0_2_234',
             'preflight_required', true
           ),
           attempts = 0,
           max_attempts = greatest(max_attempts, 3),
           run_at = now() + interval '1 minute',
           completed_at = null,
           locked_at = null,
           locked_by = null,
           error = left(
             case
               when new.executor = 'fallback_cloud'
                 then '[CLOUD_RETRY_NO_COMPATIBLE_PC] 予備Cloudでも完了せず互換PCも不在のため、Cloudで全工程を再試行します: '
               else '[CLOUD_RETRY_NO_COMPATIBLE_PC] v0.2.234以上の稼働中PCがないため、旧PCへ移管せずCloudで全工程を再試行します: '
             end || v_error,
             1000
           ),
           updated_at = now()
     where id = new.id;

    return new;
  end if;

  if new.executor = 'fallback_cloud' then
    -- PC非対応種別: Fallback Cloud が最後の砦 → 打ち切り
    if new.status <> 'failed' then
      update public.salonboard_sync_jobs
         set status = 'failed',
             completed_at = now(),
             locked_at = null,
             locked_by = null,
             error = left(
               '[FB_CLOUD_EXHAUSTED] Cloud/予備Cloudの双方で完了できませんでした: '
                 || v_error,
               1000
             ),
             updated_at = now()
       where id = new.id;
    end if;
    return new;
  end if;

  -- playwright_cloud + PC非対応種別: 現状維持
  -- (failedはfailedのまま / queuedはAdmin callbackの通常リトライに委ねる)
  return new;
end;
$function$;

-- ─────────────────────────────────────────────────────────────
-- (e) トリガWHEN句を fallback_cloud + 書込16種に拡張
-- ─────────────────────────────────────────────────────────────
drop trigger if exists trg_force_cloud_failure_fallback on public.salonboard_sync_jobs;
create trigger trg_force_cloud_failure_fallback
  after update of status, executor, attempts, error
  on public.salonboard_sync_jobs
  for each row
  when (
    new.executor in ('playwright_cloud', 'fallback_cloud')
    and new.job_type in (
      'push_booking', 'cancel_booking', 'push_shifts', 'push_blog', 'delete_blog',
      'push_review_reply', 'push_acceptance', 'push_equipment', 'push_staff',
      'push_menu', 'push_coupon', 'push_shift_patterns', 'push_salon',
      'push_kodawari', 'push_feature', 'configure_notice_mail'
    )
    and new.status in ('queued', 'failed')
  )
  execute function public.salonboard_force_cloud_failure_fallback();

-- ─────────────────────────────────────────────────────────────
-- (f) デバイスclaimから fallback_cloud レーンを除外
-- (現行は「playwright_cloud以外」の除外方式のため、新executorが店舗PCに吸われる)
-- ─────────────────────────────────────────────────────────────
create or replace function public.salonboard_claim_next_job_for_device(
  p_device_id uuid,
  p_worker_id text,
  p_limit integer default 1,
  p_lease_seconds integer default 300
)
returns setof salonboard_sync_jobs
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_status text;
  v_revoked_at timestamptz;
begin
  select status, revoked_at
    into v_status, v_revoked_at
  from public.salonboard_sync_devices
  where id = p_device_id;
  if not found then return; end if;
  if v_status <> 'active' or v_revoked_at is not null then return; end if;

  return query
  with allowed_shops as (
    select dss.shop_id
    from public.salonboard_sync_device_shops dss
    where dss.device_id = p_device_id
      and dss.enabled = true
  ),
  candidates as (
    select j.*
    from public.salonboard_sync_jobs j
    join public.salonboard_credentials c on c.shop_id = j.shop_id
    where j.status = 'queued'
      and j.run_at <= now()
      and (j.locked_at is null or j.locked_at < now() - make_interval(secs => p_lease_seconds))
      and j.shop_id in (select shop_id from allowed_shops)
      and c.enabled = true
      and (c.blocked_until is null or c.blocked_until <= now())
      and (j.executor is null or j.executor not in ('playwright_cloud', 'fallback_cloud'))
      and (public.salonboard_job_type_feature(j.job_type) is null
           or public.salonboard_feature_allowed(j.shop_id, j.organization_id,
                public.salonboard_job_type_feature(j.job_type),
                public.salonboard_job_type_direction(j.job_type)))
      and not exists (
        select 1
        from public.salonboard_sync_jobs r
        where r.shop_id = j.shop_id
          and r.status = 'running'
          and r.locked_at > now() - interval '5 minutes'
      )
    order by j.priority asc, j.run_at asc
    limit p_limit
    for update skip locked
  )
  update public.salonboard_sync_jobs j
  set status     = 'running',
      locked_at  = now(),
      locked_by  = p_worker_id,
      started_at = coalesce(j.started_at, now()),
      attempts   = j.attempts + 1,
      updated_at = now()
  from candidates
  where j.id = candidates.id
  returning j.*;
end;
$function$;

-- ─────────────────────────────────────────────────────────────
-- (g) FBレーン滞留タイムアウト (毎分cron salonboard-reroute-stale-pc-writes が
-- 関数名で呼ぶため cron 側の変更は不要)。FB workerが死んでいる時のみ10分で
-- 打ち切り、failed化により(d)のAFTERトリガが連鎖末端処理 (PCゲート/失敗確定) を行う。
-- ─────────────────────────────────────────────────────────────
create or replace function public.salonboard_reroute_stale_pc_writes()
returns integer
language plpgsql
security definer
set search_path to 'public'
as $function$
declare v_n integer := 0; v_failed integer := 0; v_fb_failed integer := 0;
begin
  update public.salonboard_sync_jobs j
     set executor = 'playwright_cloud', updated_at = now()
    from public.salonboard_credentials c
   where c.shop_id = j.shop_id
     and c.enabled = true
     and j.status = 'queued'
     and j.executor = 'playwright'
     and j.job_type in (
       'push_booking', 'cancel_booking', 'push_blog', 'delete_blog',
       'push_review_reply', 'push_shifts', 'push_staff', 'push_menu',
       'push_coupon', 'push_equipment', 'push_shift_patterns',
       'push_acceptance', 'fetch_shift_patterns'
     )
     and j.created_at < now() - interval '45 seconds'
     and coalesce(j.error, '') not like '%[CLOUD_PC_FALLBACK]%'
     and coalesce(j.payload->>'pc_fallback', 'false') <> 'true';
  get diagnostics v_n = row_count;

  -- PCフォールバック済みジョブがPCに拾われないまま10分経過 → PC不在として失敗確定。
  update public.salonboard_sync_jobs j
     set status = 'failed',
         completed_at = now(),
         locked_at = null,
         locked_by = null,
         error = coalesce(j.error, '') || ' [PC_FALLBACK_TIMEOUT] 店舗PC(予約同期くん)が10分以上応答しないためPCフォールバックを打ち切りました。PCの稼働を確認してください'
   where j.status = 'queued'
     and j.executor = 'playwright'
     and coalesce(j.payload->>'pc_fallback', 'false') = 'true'
     and j.run_at < now() - interval '10 minutes';
  get diagnostics v_failed = row_count;

  -- Fallback Cloudレーン滞留: FB worker死亡時のみ10分で打ち切り。
  -- 生きていて忙しいだけの場合 (fallback_available()=true) は刈らない。
  update public.salonboard_sync_jobs j
     set status = 'failed',
         completed_at = now(),
         locked_at = null,
         locked_by = null,
         error = left(coalesce(j.error, '') || ' [FALLBACK_CLOUD_TIMEOUT] 予備Cloud workerが10分以上応答しないため予備Cloudフォールバックを打ち切りました', 1000),
         updated_at = now()
   where j.status = 'queued'
     and j.executor = 'fallback_cloud'
     and coalesce(j.payload->>'fallback_cloud', 'false') = 'true'
     and j.run_at < now() - interval '10 minutes'
     and not public.salonboard_fallback_available();
  get diagnostics v_fb_failed = row_count;

  return v_n + v_failed + v_fb_failed;
end;
$function$;
