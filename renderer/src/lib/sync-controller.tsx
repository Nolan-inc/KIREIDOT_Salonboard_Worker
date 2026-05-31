import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { supabase } from './supabase';
import { useAuth } from './auth-context';

/**
 * 予約同期くん: utilityProcess (electron/worker-process.cjs) を制御する Context。
 *
 * - Supabase Auth セッションが取れたら worker を init (アクセストークン引き渡し)
 * - renderer から「全店舗同期 / 個別店舗同期 / 中断」を呼べる
 * - worker からの進捗イベントを購読し、状態として保持する
 */

export type ShopSyncStatus =
  | { state: 'idle' }
  | { state: 'running'; step: string; msg: string }
  | { state: 'success'; summary?: string }
  | { state: 'failed'; error: string };

export type SyncRunSummary = {
  startedAt: string;
  total: number;
  ok: number;
  ng: number;
  aborted: boolean;
  done: boolean;
};

export type ChannelKey = 'bookings' | 'staff' | 'menus' | 'shifts' | 'blog' | 'customers';

/**
 * 店舗 PC 自体の設定状態 (preflight 結果)。
 *
 *   code: 'ok'                  → device + credentials + consent すべて揃って同期可能
 *   code: 'device_unconfigured' → SALONBOARD_DEVICE_ID/TOKEN 未設定 (ローカル設定)
 *   code: 'device_unauthorized' → token 不一致 / revoked / paused (Admin で無効化)
 *   code: 'no_shops_assigned'   → device に shop が紐付いていない
 *   code: 'all_shops_blocked'   → 全 shop が blocked_until 中
 *   code: 'missing_consent'     → consent 未取得の shop あり (一部のみ動作)
 *   code: 'missing_credentials' → credentials 未設定の shop あり
 *   code: 'network_error'       → API 疎通失敗 (Admin が落ちている / オフライン)
 *   code: 'unknown'             → preflight 未実行 or 例外
 */
export type SyncSetupStatus = {
  code:
    | 'ok'
    | 'device_unconfigured'
    | 'device_unauthorized'
    | 'no_shops_assigned'
    | 'all_shops_blocked'
    | 'missing_consent'
    | 'missing_credentials'
    | 'network_error'
    | 'unknown';
  message: string;
  /** UI で詳しく見たい場合の補助情報 */
  detail?: {
    deviceStatus?: string | null;
    shopsTotal?: number;
    shopsReady?: number;
    blockedShops?: number;
  };
};

type SyncContextValue = {
  ready: boolean;
  isRunning: boolean;
  // shopId -> 状態
  shopStatuses: Record<string, ShopSyncStatus>;
  lastRun: SyncRunSummary | null;
  // worker のログ (リング 200 件)
  logs: { at: string; level: 'info' | 'warn' | 'error'; msg: string }[];
  /** 店舗PC自体の設定状態 (preflight)。起動直後は code: 'unknown' */
  setupStatus: SyncSetupStatus;
  /** preflight を即時再実行する */
  refreshSetupStatus: () => Promise<void>;
  /** 自動同期が有効か (sync_interval_minutes に従って全チャネルを定期実行) */
  autoSyncEnabled: boolean;
  setAutoSyncEnabled: (v: boolean) => void;
  /** 予約だけを 5 分おきに自動取得するモード */
  bookingsAutoSyncEnabled: boolean;
  setBookingsAutoSyncEnabled: (v: boolean) => void;
  /** 予約自動同期の最後の実行時刻 (ms, ローカル時刻基準) */
  lastBookingsAutoSyncAt: number | null;

  syncAll: (
    channels?: ChannelKey[],
    opts?: { showBrowser?: boolean },
  ) => Promise<{ ok: boolean; error?: string }>;
  syncShops: (
    shopIds: string[],
    channels?: ChannelKey[],
    opts?: { showBrowser?: boolean },
  ) => Promise<{ ok: boolean; error?: string }>;
  abort: () => Promise<void>;
};

const SyncContext = createContext<SyncContextValue | null>(null);

const DEFAULT_CHANNELS: ChannelKey[] = ['bookings', 'staff', 'menus', 'shifts', 'blog', 'customers'];

/** 自動同期 ON/OFF を localStorage に保存するキー */
const AUTO_SYNC_KEY = 'salondesk.autoSyncEnabled';
/** 自動同期チェック間隔 (ms)。実行間隔ではなく「実行可否を判定する周期」 */
const AUTO_SYNC_TICK_MS = 60_000; // 60 秒に 1 回判定

/** 「予約のみ」自動同期 ON/OFF を localStorage に保存するキー */
const BOOKINGS_AUTO_SYNC_KEY = 'salondesk.bookingsAutoSyncEnabled';
/**
 * 「予約のみ」自動同期の実行間隔。
 * 固定間隔だと SalonBoard 側のアクセスパターン検知 (BAN) を招きやすいため、
 * 毎回 1〜10 分の範囲でランダムに選ぶ (実行のたびに再抽選)。
 */
const BOOKINGS_AUTO_SYNC_MIN_MS = 1 * 60_000; // 下限 1 分
const BOOKINGS_AUTO_SYNC_MAX_MS = 10 * 60_000; // 上限 10 分
/** 1〜10 分のランダムな間隔 (ms) を返す。 */
function randomBookingsIntervalMs(): number {
  const span = BOOKINGS_AUTO_SYNC_MAX_MS - BOOKINGS_AUTO_SYNC_MIN_MS;
  return BOOKINGS_AUTO_SYNC_MIN_MS + Math.floor(Math.random() * (span + 1));
}
/** 「予約のみ」自動同期の判定周期 (30 秒)。実行間隔ではなく「実行可否を判定する周期」。 */
const BOOKINGS_AUTO_SYNC_TICK_MS = 30_000;

export function SyncControllerProvider({ children }: { children: ReactNode }) {
  const auth = useAuth();
  const [ready, setReady] = useState(false);
  const [isRunning, setIsRunning] = useState(false);
  const [shopStatuses, setShopStatuses] = useState<Record<string, ShopSyncStatus>>({});
  const [lastRun, setLastRun] = useState<SyncRunSummary | null>(null);
  const [logs, setLogs] = useState<SyncContextValue['logs']>([]);
  const [setupStatus, setSetupStatus] = useState<SyncSetupStatus>({
    code: 'unknown',
    message: '設定状態を確認中…',
  });
  const runningRef = useRef(false);
  const [autoSyncEnabled, setAutoSyncEnabledState] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    try {
      return localStorage.getItem(AUTO_SYNC_KEY) === '1';
    } catch {
      return false;
    }
  });
  const setAutoSyncEnabled = useCallback((v: boolean) => {
    setAutoSyncEnabledState(v);
    try {
      localStorage.setItem(AUTO_SYNC_KEY, v ? '1' : '0');
    } catch {
      /* ignore */
    }
  }, []);
  /** 最後に自動同期を実行した時刻 (ms) */
  const lastAutoSyncAtRef = useRef<number>(0);

  // ---- 「予約のみ」5 分おき自動同期 ----
  const [bookingsAutoSyncEnabled, setBookingsAutoSyncEnabledState] = useState<boolean>(
    () => {
      if (typeof window === 'undefined') return false;
      try {
        return localStorage.getItem(BOOKINGS_AUTO_SYNC_KEY) === '1';
      } catch {
        return false;
      }
    },
  );
  const setBookingsAutoSyncEnabled = useCallback((v: boolean) => {
    setBookingsAutoSyncEnabledState(v);
    try {
      localStorage.setItem(BOOKINGS_AUTO_SYNC_KEY, v ? '1' : '0');
    } catch {
      /* ignore */
    }
  }, []);
  const lastBookingsAutoSyncAtRef = useRef<number>(0);
  /** 次回「予約のみ」同期までの間隔 (ms)。1〜10 分でランダムに決め、実行のたびに再抽選。 */
  const nextBookingsIntervalRef = useRef<number>(randomBookingsIntervalMs());
  const [lastBookingsAutoSyncAt, setLastBookingsAutoSyncAt] = useState<number | null>(
    null,
  );

  // Worker 初期化: ログイン状態が変わるたびにセッショントークンを渡し直す
  useEffect(() => {
    const bridge = typeof window !== 'undefined' ? window.kireidotApp : undefined;
    if (!bridge) return;
    if (auth.status !== 'signed-in') {
      setReady(false);
      return;
    }
    const accessToken = auth.session.access_token;
    const refreshToken = auth.session.refresh_token;
    if (!accessToken || !refreshToken) return;
    let cancelled = false;
    (async () => {
      // v0.2.5: device_id / device_token / apiBaseUrl は renderer から渡さない。
      // main process が userData (salonboard-device.json) から読み、worker:init の
      // payload にマージして worker に渡す。renderer は Supabase セッションだけ渡す。
      const r = await bridge.workerInit({
        url: import.meta.env.VITE_SUPABASE_URL ?? '',
        anonKey: import.meta.env.VITE_SUPABASE_ANON_KEY ?? '',
        accessToken,
        refreshToken,
      });
      if (!cancelled) setReady(!!r?.ok);
    })();
    return () => {
      cancelled = true;
    };
  }, [auth]);

  // Worker からのイベントを購読
  useEffect(() => {
    const bridge = typeof window !== 'undefined' ? window.kireidotApp : undefined;
    if (!bridge) return;
    const unsubscribe = bridge.onWorkerEvent((msg) => {
      switch (msg.type) {
        case 'boot':
          // worker プロセス自体は起動した (Supabase init 前)
          break;
        case 'ready':
          // Supabase client セット完了 → 同期可能
          if (msg.payload.ok) setReady(true);
          break;
        case 'log':
          setLogs((cur) => [...cur, msg.payload].slice(-200));
          break;
        case 'run:start':
          runningRef.current = true;
          setIsRunning(true);
          setLastRun({
            startedAt: new Date().toISOString(),
            total: msg.payload.total,
            ok: 0,
            ng: 0,
            aborted: false,
            done: false,
          });
          // 既存ステータスは引き継ぎつつ、新規実行対象を idle に戻す...は
          // shop:start で個別に running に書き換わるので何もしない
          break;
        case 'shop:start':
          setShopStatuses((cur) => ({
            ...cur,
            [msg.payload.shopId]: { state: 'running', step: 'start', msg: '開始' },
          }));
          break;
        case 'shop:progress':
          setShopStatuses((cur) => ({
            ...cur,
            [msg.payload.shopId]: {
              state: 'running',
              step: msg.payload.step,
              msg: msg.payload.msg,
            },
          }));
          break;
        case 'shop:end':
          setShopStatuses((cur) => ({
            ...cur,
            [msg.payload.shopId]: msg.payload.ok
              ? { state: 'success', summary: msg.payload.summary }
              : {
                  state: 'failed',
                  // userHint があれば人間向け案内を優先、無ければ error 原文
                  error:
                    (msg.payload.userHint && `${msg.payload.userHint}`) ||
                    msg.payload.error ||
                    'unknown',
                },
          }));
          // 失敗のうち再試行非推奨なものはユーザー向けログにも残す
          if (
            !msg.payload.ok &&
            msg.payload.errorCode &&
            ['captcha_detected', 'blocked', 'rate_limited', 'login_required'].includes(
              msg.payload.errorCode,
            )
          ) {
            setLogs((cur) =>
              [
                ...cur,
                {
                  at: new Date().toISOString(),
                  level: 'warn' as const,
                  msg: `[${msg.payload.errorCode}] ${msg.payload.userHint ?? msg.payload.error ?? ''}${
                    msg.payload.blockedUntil
                      ? ` (解除予定: ${new Date(msg.payload.blockedUntil).toLocaleString('ja-JP')})`
                      : ''
                  }`,
                },
              ].slice(-200),
            );
          }
          setLastRun((cur) => {
            if (!cur) return cur;
            return msg.payload.ok
              ? { ...cur, ok: cur.ok + 1 }
              : { ...cur, ng: cur.ng + 1 };
          });
          break;
        case 'shop:record':
          // 監査用の構造化レコード。今は何も UI に出さないが、将来 device 状態カードや
          // 履歴画面で参照する想定。現時点では log には流さない (ノイズ多いため)。
          break;
        case 'run:end':
          runningRef.current = false;
          setIsRunning(false);
          setLastRun((cur) =>
            cur
              ? {
                  ...cur,
                  total: msg.payload.total,
                  ok: msg.payload.ok,
                  ng: msg.payload.ng,
                  aborted: msg.payload.aborted,
                  done: true,
                }
              : cur,
          );
          break;
        case 'error':
          setLogs((cur) =>
            [
              ...cur,
              { at: new Date().toISOString(), level: 'error' as const, msg: msg.payload.msg },
            ].slice(-200),
          );
          break;
        case 'exited':
          runningRef.current = false;
          setIsRunning(false);
          setReady(false);
          setLogs((cur) =>
            [
              ...cur,
              {
                at: new Date().toISOString(),
                level: 'warn' as const,
                msg: `worker exited (code=${msg.payload.code})`,
              },
            ].slice(-200),
          );
          break;
      }
    });
    return () => {
      try {
        unsubscribe();
      } catch {
        /* ignore */
      }
    };
  }, []);

  /**
   * device 設定の self-check を実行する (preflight)。
   *
   * 起動直後と「同期ボタン押下前」に呼ぶ想定。Admin の /overview API を 1 回叩き、
   * 失敗種別ごとに setupStatus にユーザー向けメッセージを入れる。
   */
  const refreshSetupStatus = useCallback(async () => {
    // v0.2.5: renderer は token を持たない。main の device:test (userData 設定で
    // overview API を叩く) を使って状態判定する。
    const bridge = typeof window !== 'undefined' ? window.kireidotApp : undefined;
    const overview = bridge?.deviceConfig
      ? await bridge.deviceConfig.test()
      : { ok: false, code: 'device_unconfigured' as const, shops: [] };

    if (!overview.ok) {
      switch (overview.code) {
        case 'device_unconfigured':
        case 'device_auth_missing':
          setSetupStatus({
            code: 'device_unconfigured',
            message:
              'デバイス設定が未完了です。設定画面の「SalonBoard連携デバイス」で Device ID / Token を登録してください。',
          });
          return;
        case 'unauthorized':
        case 'http_401':
          setSetupStatus({
            code: 'device_unauthorized',
            message:
              'この店舗PCは管理画面で無効化されているか、デバイストークンが一致しません。Admin の /admin/salonboard/devices で確認してください。',
          });
          return;
        case 'network_error':
          setSetupStatus({
            code: 'network_error',
            message:
              'KIREIDOT Admin との通信に失敗しました。インターネット接続と API URL を確認してください。',
          });
          return;
        case 'no_shops_assigned':
          setSetupStatus({
            code: 'no_shops_assigned',
            message:
              'この店舗PCに紐付いた店舗がありません。管理画面で device に shop を紐付けてください。',
          });
          return;
        default:
          setSetupStatus({
            code: 'unknown',
            message: `設定確認に失敗しました (${overview.code ?? 'unknown'})`,
          });
          return;
      }
    }

    const shops = overview.shops ?? [];
    if (shops.length === 0) {
      setSetupStatus({
        code: 'no_shops_assigned',
        message:
          'この店舗PCに紐付いた店舗がありません。管理画面で device に shop を紐付けてください。',
      });
      return;
    }
    const now = Date.now();
    const blocked = shops.filter(
      (s) => s.blocked_until && new Date(s.blocked_until).getTime() > now,
    );
    const missingCred = shops.filter((s) => s.credential_status === 'missing');
    const missingConsent = shops.filter((s) => s.consent_status === 'missing');
    const ready = shops.filter(
      (s) =>
        s.credential_status === 'active' &&
        s.enabled &&
        s.consent_status === 'valid' &&
        !(s.blocked_until && new Date(s.blocked_until).getTime() > now),
    );

    const detail = {
      shopsTotal: shops.length,
      shopsReady: ready.length,
      blockedShops: blocked.length,
      deviceStatus: overview.device?.status ?? null,
    };

    if (ready.length === 0 && blocked.length === shops.length) {
      setSetupStatus({
        code: 'all_shops_blocked',
        message: 'すべての店舗が一時ブロック中です。時間を空けて再試行してください。',
        detail,
      });
      return;
    }
    if (missingCred.length > 0 && ready.length === 0) {
      setSetupStatus({
        code: 'missing_credentials',
        message:
          'SalonBoard 認証情報が未設定の店舗があります (' +
          missingCred.length +
          '件)。Admin で設定してください。',
        detail,
      });
      return;
    }
    if (missingConsent.length > 0 && ready.length === 0) {
      setSetupStatus({
        code: 'missing_consent',
        message:
          'SalonBoard 連携の同意が未取得の店舗があります (' +
          missingConsent.length +
          '件)。Admin で同意を取得してください。',
        detail,
      });
      return;
    }

    setSetupStatus({
      code: 'ok',
      message:
        ready.length === shops.length
          ? `${ready.length} 店舗とも同期可能です。`
          : `${ready.length}/${shops.length} 店舗が同期可能です (残りは設定不備またはブロック中)。`,
      detail,
    });
  }, []);

  // ready が true になったら 1 回 preflight を走らせる
  useEffect(() => {
    if (!ready) return;
    void refreshSetupStatus();
  }, [ready, refreshSetupStatus]);

  const syncAll = useCallback<SyncContextValue['syncAll']>(
    async (channels = DEFAULT_CHANNELS, opts) => {
      const bridge = typeof window !== 'undefined' ? window.kireidotApp : undefined;
      if (!bridge) return { ok: false, error: 'Electron 環境ではありません' };
      if (!ready) {
        // セッションが新鮮かどうかを念のため確認
        const { data } = await supabase.auth.getSession();
        if (!data.session) return { ok: false, error: '未ログインです' };
      }
      const r = await bridge.workerSync({ channels, showBrowser: !!opts?.showBrowser });
      return { ok: !!r?.ok };
    },
    [ready],
  );

  const syncShops = useCallback<SyncContextValue['syncShops']>(
    async (shopIds, channels = DEFAULT_CHANNELS, opts) => {
      const bridge = typeof window !== 'undefined' ? window.kireidotApp : undefined;
      if (!bridge) return { ok: false, error: 'Electron 環境ではありません' };
      if (!shopIds || shopIds.length === 0) return { ok: false, error: '店舗が指定されていません' };
      if (!ready) {
        return {
          ok: false,
          error: '同期ワーカーがまだ初期化されていません。数秒待ってからもう一度お試しください。',
        };
      }
      const r = await bridge.workerSync({
        shopIds,
        channels,
        showBrowser: !!opts?.showBrowser,
      });
      return { ok: !!r?.ok };
    },
    [ready],
  );

  const abort = useCallback(async () => {
    const bridge = typeof window !== 'undefined' ? window.kireidotApp : undefined;
    await bridge?.workerAbort();
  }, []);

  // ---- 自動同期スケジューラ ----
  // sync_interval_minutes は店舗ごとに違うが、ここでは「全店舗最短間隔」で全体を回す。
  // 店舗ごとの細かい間隔管理は将来 worker 側に移すのが理想だが、まず実用に足る挙動として
  // 「最短 sync_interval_minutes ぶん経過したら syncAll を発火」で実装。
  useEffect(() => {
    if (!autoSyncEnabled || !ready) return;
    let cancelled = false;

    const tick = async () => {
      if (cancelled) return;
      if (runningRef.current) return; // 既に走っているならスキップ

      // v0.2.5: device 設定 (userData) 経由で overview を取得 (main 経由)。
      // active な店舗が 1 つでもあれば 12 分間隔で同期する (このループは
      // 「設定が生きていれば走る」ガード)。device 未設定なら何もしない。
      const bridge = typeof window !== 'undefined' ? window.kireidotApp : undefined;
      const overview = bridge?.deviceConfig
        ? await bridge.deviceConfig.test()
        : { ok: false, shops: [] as never[] };
      let intervals: number[] = [];
      if (overview.ok) {
        const activeShops = (overview.shops ?? []).filter(
          (s) => s.credential_status === 'active' && s.enabled,
        );
        if (activeShops.length > 0) intervals = [12];
      }
      if (intervals.length === 0) return;
      const minInterval = Math.min(...intervals);
      const elapsed = Date.now() - lastAutoSyncAtRef.current;
      if (elapsed < minInterval * 60_000) return;
      // 実行
      lastAutoSyncAtRef.current = Date.now();
      if (!bridge) return;
      await bridge.workerSync({ channels: DEFAULT_CHANNELS });
    };

    // 起動直後にも 1 回判定 (短い遅延を入れて初期化完了を待つ)
    const initialDelay = setTimeout(() => void tick(), 5_000);
    const interval = setInterval(() => void tick(), AUTO_SYNC_TICK_MS);
    return () => {
      cancelled = true;
      clearTimeout(initialDelay);
      clearInterval(interval);
    };
  }, [autoSyncEnabled, ready]);

  // ---- 「予約のみ」5 分おき自動同期 ----
  // 上の自動同期と独立した別ループ。連携済みかつ enabled な全店舗を対象に、
  // channels=['bookings'] だけで workerSync を呼ぶ。
  useEffect(() => {
    if (!bookingsAutoSyncEnabled || !ready) return;
    let cancelled = false;

    const tick = async () => {
      if (cancelled) return;
      // 既に同期が走っているならスキップ (全チャネル同期と競合させない)
      if (runningRef.current) return;
      const elapsed = Date.now() - lastBookingsAutoSyncAtRef.current;
      // 固定間隔だと BAN されやすいので、毎回 1〜10 分のランダム間隔で実行する。
      if (elapsed < nextBookingsIntervalRef.current) return;

      // 対象店舗: 認証情報があり enabled な店舗の shop_id 一覧
      // v0.2.5: device 設定 (userData) 経由で overview を取得 (main 経由)
      const now = Date.now();
      let shopIds: string[] = [];
      const bridge = typeof window !== 'undefined' ? window.kireidotApp : undefined;
      if (!bridge?.deviceConfig) return;
      const overview = await bridge.deviceConfig.test();
      if (overview.ok) {
        shopIds = (overview.shops ?? [])
          .filter((s) => {
            if (s.credential_status !== 'active') return false;
            if (!s.enabled) return false;
            if (s.blocked_until && new Date(s.blocked_until).getTime() > now)
              return false;
            return true;
          })
          .map((s) => s.shop_id);
      }
      if (shopIds.length === 0) return;

      lastBookingsAutoSyncAtRef.current = Date.now();
      setLastBookingsAutoSyncAt(lastBookingsAutoSyncAtRef.current);
      // 次回の間隔を 1〜10 分で再抽選 (アクセス間隔を一定にしない)。
      nextBookingsIntervalRef.current = randomBookingsIntervalMs();
      await bridge.workerSync({ shopIds, channels: ['bookings'] });
    };

    // 起動直後にも 1 回判定
    const initialDelay = setTimeout(() => void tick(), 5_000);
    const interval = setInterval(() => void tick(), BOOKINGS_AUTO_SYNC_TICK_MS);
    return () => {
      cancelled = true;
      clearTimeout(initialDelay);
      clearInterval(interval);
    };
  }, [bookingsAutoSyncEnabled, ready]);

  const value = useMemo<SyncContextValue>(
    () => ({
      ready,
      isRunning,
      shopStatuses,
      lastRun,
      logs,
      setupStatus,
      refreshSetupStatus,
      autoSyncEnabled,
      setAutoSyncEnabled,
      bookingsAutoSyncEnabled,
      setBookingsAutoSyncEnabled,
      lastBookingsAutoSyncAt,
      syncAll,
      syncShops,
      abort,
    }),
    [
      ready,
      isRunning,
      shopStatuses,
      lastRun,
      logs,
      setupStatus,
      refreshSetupStatus,
      autoSyncEnabled,
      setAutoSyncEnabled,
      bookingsAutoSyncEnabled,
      setBookingsAutoSyncEnabled,
      lastBookingsAutoSyncAt,
      syncAll,
      syncShops,
      abort,
    ],
  );

  return <SyncContext.Provider value={value}>{children}</SyncContext.Provider>;
}

export function useSyncController(): SyncContextValue {
  const ctx = useContext(SyncContext);
  if (!ctx) throw new Error('SyncControllerProvider が見つかりません');
  return ctx;
}
