-- PC成功率0%の根治 (2026-08-02 調査):
--
-- 1) データ起因のスケジュール衝突はPC移管しない。
--    SalonBoard は既存予定と重複する予定登録POSTを「受理した上で黙って破棄」する。
--    この失敗 (予定登録POSTは受理されましたが〜実在を確認できません /
--    入力された時間帯に別のシフトまたは予定が登録されています) は実行環境を
--    変えても結果が変わらないのに、従来はPCへ移管され、PCがclaimしないまま
--    10分で PC_FALLBACK_TIMEOUT 死していた (直近36hのPC失敗309件中268件)。
--    push_booking / cancel_booking は write_attempts の manual_required 行で
--    既に除外されるが、push_shifts は write_attempts を記録しないため、
--    エラーメッセージのパターンでも除外する。
--
-- 2) 互換PCゲートを「フォールバックジョブをclaimできるPC」に合わせる。
--    - v0.2.233 までの予約同期くんは保険ポーリングが push_photo_gallery しか
--      監視せず、フォールバック書込 (既存行のUPDATE) を検知できない。
--      claim経路を持つのは v0.2.234 以降のみ → バージョン下限を引き上げる。
--    - heartbeat は5分間隔送信なのに従来の判定窓は2分で、移管可否が
--      タイミング運任せだった → salonboard_pc_available() と同じ7分に揃える。

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
begin
  if pg_trigger_depth() > 1 then
    return new;
  end if;

  select wa.status
    into v_latest_attempt_status
    from public.salonboard_write_attempts wa
   where wa.job_id = new.id
   order by wa.created_at desc, wa.id desc
   limit 1;

  v_should_fallback :=
    new.executor = 'playwright_cloud'
    and new.job_type in ('push_booking', 'cancel_booking', 'push_shifts')
    and v_latest_attempt_status is distinct from 'manual_required'
    -- SBが重複としてPOSTを破棄するデータ起因の衝突は、PC/Cloudどちらで
    -- 再実行しても同じ結果になるため再投入しない (failed のまま確定させ、
    -- Admin側で manual_required として人に表面化させる)。
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

  v_error := regexp_replace(
    coalesce(new.error, 'Cloud処理が完了しませんでした'),
    '^\[(CLOUD_PC_FALLBACK|CLOUD_RETRY_NO_COMPATIBLE_PC)\][^:]*:\s*',
    ''
  );

  if not v_compatible_pc_online then
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
             '[CLOUD_RETRY_NO_COMPATIBLE_PC] v0.2.234以上の稼働中PCがないため、'
               || '旧PCへ移管せずCloudで全工程を再試行します: '
               || v_error,
             1000
           ),
           updated_at = now()
     where id = new.id;

    return new;
  end if;

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
           'pc_fallback_from', 'playwright_cloud',
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
           '[CLOUD_PC_FALLBACK] Cloudで3回完了できなかったため'
             || '互換PCで再実行します: '
             || v_error,
           1000
         ),
         updated_at = now()
   where id = new.id;

  return new;
end;
$function$;

revoke all on function public.salonboard_force_cloud_failure_fallback()
  from public, anon, authenticated;

-- 現在滞留中のデータ起因衝突ジョブを確定させる。
-- (a) Cloudでcycle中 / PCレーンでqueuedのまま死を待つジョブを failed に。
--     ※ 新しい関数定義が先に入っているため、この UPDATE で発火するトリガーは
--       エラーパターン除外により再投入しない。
update public.salonboard_sync_jobs j
   set status = 'failed',
       attempts = greatest(j.attempts, j.max_attempts),
       completed_at = now(),
       locked_at = null,
       locked_by = null,
       updated_at = now()
 where j.job_type in ('push_booking', 'cancel_booking', 'push_shifts')
   and j.status = 'queued'
   and coalesce(j.error, '') ~
     '予定登録POSTは受理されました|入力された時間帯に別のシフトまたは予定が登録されています';

-- (b) 上記で確定した push_booking のうち、予約側が進行中表示のまま残っている
--     ものを manual_required に落として人に見えるようにする
--     (PC_FALLBACK_TIMEOUT 死したジョブは bookings を 'pushing' のまま放置していた)。
update public.bookings b
   set salonboard_sync_status = 'manual_required',
       salonboard_last_push_error = left(
         '[CONFIRMATION_MISMATCH] ' || coalesce(j.error, 'SalonBoard側の既存予定と重複しています'),
         1000
       )
  from public.salonboard_sync_jobs j
 where j.job_type = 'push_booking'
   and j.status = 'failed'
   and coalesce(j.error, '') ~
     '予定登録POSTは受理されました|入力された時間帯に別のシフトまたは予定が登録されています'
   and (j.payload->>'booking_id') ~
     '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
   and b.id = (j.payload->>'booking_id')::uuid
   and b.salonboard_sync_status in ('pushing', 'pending_push', 'failed');
