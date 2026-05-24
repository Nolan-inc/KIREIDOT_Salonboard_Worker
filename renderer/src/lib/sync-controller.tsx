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

type ChannelKey = 'bookings' | 'staff' | 'shifts' | 'blog' | 'customers';

type SyncContextValue = {
  ready: boolean;
  isRunning: boolean;
  // shopId -> 状態
  shopStatuses: Record<string, ShopSyncStatus>;
  lastRun: SyncRunSummary | null;
  // worker のログ (リング 200 件)
  logs: { at: string; level: 'info' | 'warn' | 'error'; msg: string }[];
  /** 自動同期が有効か (sync_interval_minutes に従って定期実行) */
  autoSyncEnabled: boolean;
  setAutoSyncEnabled: (v: boolean) => void;

  syncAll: (channels?: ChannelKey[]) => Promise<{ ok: boolean; error?: string }>;
  syncShops: (shopIds: string[], channels?: ChannelKey[]) => Promise<{ ok: boolean; error?: string }>;
  abort: () => Promise<void>;
};

const SyncContext = createContext<SyncContextValue | null>(null);

const DEFAULT_CHANNELS: ChannelKey[] = ['bookings', 'staff', 'blog', 'customers'];

/** 自動同期 ON/OFF を localStorage に保存するキー */
const AUTO_SYNC_KEY = 'salondesk.autoSyncEnabled';
/** 自動同期チェック間隔 (ms)。実行間隔ではなく「実行可否を判定する周期」 */
const AUTO_SYNC_TICK_MS = 60_000; // 60 秒に 1 回判定

export function SyncControllerProvider({ children }: { children: ReactNode }) {
  const auth = useAuth();
  const [ready, setReady] = useState(false);
  const [isRunning, setIsRunning] = useState(false);
  const [shopStatuses, setShopStatuses] = useState<Record<string, ShopSyncStatus>>({});
  const [lastRun, setLastRun] = useState<SyncRunSummary | null>(null);
  const [logs, setLogs] = useState<SyncContextValue['logs']>([]);
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
        case 'ready':
          // setReady は init 完了時にもう立てている
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
              : { state: 'failed', error: msg.payload.error ?? 'unknown' },
          }));
          setLastRun((cur) => {
            if (!cur) return cur;
            return msg.payload.ok
              ? { ...cur, ok: cur.ok + 1 }
              : { ...cur, ng: cur.ng + 1 };
          });
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

  const syncAll = useCallback<SyncContextValue['syncAll']>(
    async (channels = DEFAULT_CHANNELS) => {
      const bridge = typeof window !== 'undefined' ? window.kireidotApp : undefined;
      if (!bridge) return { ok: false, error: 'Electron 環境ではありません' };
      if (!ready) {
        // セッションが新鮮かどうかを念のため確認
        const { data } = await supabase.auth.getSession();
        if (!data.session) return { ok: false, error: '未ログインです' };
      }
      const r = await bridge.workerSync({ channels });
      return { ok: !!r?.ok };
    },
    [ready],
  );

  const syncShops = useCallback<SyncContextValue['syncShops']>(
    async (shopIds, channels = DEFAULT_CHANNELS) => {
      const bridge = typeof window !== 'undefined' ? window.kireidotApp : undefined;
      if (!bridge) return { ok: false, error: 'Electron 環境ではありません' };
      if (!shopIds || shopIds.length === 0) return { ok: false, error: '店舗が指定されていません' };
      const r = await bridge.workerSync({ shopIds, channels });
      return { ok: !!r?.ok };
    },
    [],
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
      // 最短間隔を取得
      const { data } = await supabase
        .from('salonboard_credentials_overview')
        .select('sync_interval_minutes, has_credential, enabled')
        .eq('has_credential', true)
        .eq('enabled', true);
      const intervals = (data ?? [])
        .map((r) => Number((r as any).sync_interval_minutes))
        .filter((n) => Number.isFinite(n) && n > 0);
      if (intervals.length === 0) return;
      const minInterval = Math.min(...intervals);
      const elapsed = Date.now() - lastAutoSyncAtRef.current;
      if (elapsed < minInterval * 60_000) return;
      // 実行
      lastAutoSyncAtRef.current = Date.now();
      const bridge = typeof window !== 'undefined' ? window.kireidotApp : undefined;
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

  const value = useMemo<SyncContextValue>(
    () => ({
      ready,
      isRunning,
      shopStatuses,
      lastRun,
      logs,
      autoSyncEnabled,
      setAutoSyncEnabled,
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
      autoSyncEnabled,
      setAutoSyncEnabled,
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
