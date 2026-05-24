/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL: string;
  readonly VITE_SUPABASE_ANON_KEY: string;
  readonly VITE_APP_NAME?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

// preload.cjs で contextBridge.exposeInMainWorld した API の型。
type UpdaterStatus =
  | { type: 'checking' }
  | { type: 'not-available' }
  | { type: 'available'; version: string }
  | { type: 'downloading'; percent: number; transferred?: number; total?: number }
  | { type: 'downloaded'; version: string }
  | { type: 'error'; message: string };

// utilityProcess (electron/worker-process.cjs) からのイベント。
type WorkerChannel = 'bookings' | 'staff' | 'shifts' | 'blog' | 'customers';
type WorkerEvent =
  | { type: 'boot'; payload: { pid: number; at: string } }
  | { type: 'ready'; payload: { ok: boolean } }
  | { type: 'log'; payload: { level: 'info' | 'warn' | 'error'; msg: string; at: string } }
  | { type: 'error'; payload: { msg: string } }
  | { type: 'run:start'; payload: { total: number; channels: WorkerChannel[] } }
  | { type: 'run:end'; payload: { total: number; ok: number; ng: number; aborted: boolean } }
  | {
      type: 'shop:start';
      payload: { shopId: string; shopName: string; orgName: string; channels: WorkerChannel[] };
    }
  | {
      type: 'shop:progress';
      payload: { shopId: string; step: string; msg: string };
    }
  | {
      type: 'shop:end';
      payload: { shopId: string; ok: boolean; summary?: string; error?: string };
    }
  | { type: 'exited'; payload: { code: number | null } };

interface Window {
  salondesk?: {
    version: string;
    platform: NodeJS.Platform;
  };
  kireidotApp?: {
    /** 外部 URL (http/https) をシステムブラウザで開く。 */
    openExternal: (url: string) => Promise<{ ok: boolean; error?: string }>;
    /**
     * Deep Link 受信時に呼び出されるリスナーを登録する。返値は解除関数。
     */
    onOAuthCallback: (handler: (url: string) => void) => () => void;
    /** 自動アップデーターのステータス変化を購読する。返値は解除関数。 */
    onUpdaterStatus: (handler: (status: UpdaterStatus) => void) => () => void;
    /** 「今すぐ再起動して更新を適用」をリクエストする。 */
    quitAndInstallUpdate: () => Promise<{ ok: boolean }>;

    /** worker (utilityProcess) を Supabase セッション付きで初期化 */
    workerInit: (payload: {
      url: string;
      anonKey: string;
      accessToken: string;
      refreshToken: string;
    }) => Promise<{ ok: boolean }>;
    /** 同期実行: shopIds 未指定で全店舗 */
    workerSync: (payload: {
      shopIds?: string[];
      channels: WorkerChannel[];
    }) => Promise<{ ok: boolean }>;
    /** 現在の同期を中断 */
    workerAbort: () => Promise<{ ok: boolean }>;
    /** worker からの全イベントを購読。返値は解除関数 */
    onWorkerEvent: (handler: (msg: WorkerEvent) => void) => () => void;
  };
}
