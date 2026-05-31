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
      payload: {
        shopId: string;
        ok: boolean;
        summary?: string;
        error?: string;
        /**
         * 失敗時に worker-process.cjs が classifyError で分類した状態コード。
         * 'captcha_detected' | 'blocked' | 'rate_limited' | 'session_expired'
         * | 'login_required' | 'non_retryable_failed' | 'retryable_failed'
         * | 'already_in_progress'
         */
        errorCode?: string;
        /** UI に表示する人間向け案内 (classifyError の userHint) */
        userHint?: string;
        /** captcha / blocked / rate_limited の場合の解除予定時刻 (ISO) */
        blockedUntil?: string | null;
      };
    }
  | {
      type: 'shop:record';
      payload: {
        shopId: string;
        ok: boolean;
        summary?: string | null;
        error?: string | null;
        counts: { bookings: number; staff: number; blogs: number; customers: number };
        meta: {
          worker_id: string;
          device_id: string | null;
          app_version: string | null;
          platform: string;
          storage_state_used: boolean | null;
          session_reused: boolean | null;
          login_attempted: boolean | null;
        };
      };
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
    /** 手動でアップデート確認を実行する。結果は onUpdaterStatus 経由で受け取る。 */
    checkForUpdate: () => Promise<{ ok: boolean; reason?: string }>;

    /**
     * worker (utilityProcess) を Supabase セッション + device 認証情報付きで初期化。
     * device 認証情報 (apiBaseUrl/deviceId/deviceToken) は credential 取得を
     * Admin API 経由 (/api/salonboard/device/credentials) に寄せるために使う。
     * v0.2.2 で追加。未設定でも worker は起動するが credential 取得が必ず失敗する。
     */
    workerInit: (payload: {
      url: string;
      anonKey: string;
      accessToken: string;
      refreshToken: string;
      apiBaseUrl?: string;
      deviceId?: string;
      deviceToken?: string;
      workerId?: string;
      appVersion?: string;
    }) => Promise<{ ok: boolean }>;
    /** 同期実行: shopIds 未指定で全店舗 */
    workerSync: (payload: {
      shopIds?: string[];
      channels: WorkerChannel[];
      /** true でブラウザを表示 (headless: false + slowMo)。デバッグ・確認用 */
      showBrowser?: boolean;
    }) => Promise<{ ok: boolean }>;
    /** 現在の同期を中断 */
    workerAbort: () => Promise<{ ok: boolean }>;
    /** worker からの全イベントを購読。返値は解除関数 */
    onWorkerEvent: (handler: (msg: WorkerEvent) => void) => () => void;

    /**
     * Supabase Auth セッション永続化用ストレージ (v0.2.9)。
     * 本番ビルドの file:// で localStorage が失われる問題への対処として
     * userData/auth-storage.json に保存する。
     */
    authStorage: {
      getItem: (key: string) => Promise<string | null>;
      setItem: (key: string, value: string) => Promise<{ ok: boolean }>;
      removeItem: (key: string) => Promise<{ ok: boolean }>;
    };

    /**
     * device 設定 (v0.2.5)。店舗 PC ごとの device_id / device_token を
     * userData に保存する。token は get では last4 のみ返す。
     */
    deviceConfig: {
      get: () => Promise<DeviceConfigMasked>;
      save: (payload: {
        deviceId?: string;
        deviceToken: string;
        apiUrl: string;
        deviceName?: string;
        workerId?: string;
      }) => Promise<DeviceConfigTestResult & { config: DeviceConfigMasked }>;
      clear: () => Promise<{ ok: boolean }>;
      test: (payload?: {
        deviceId?: string;
        deviceToken: string;
        apiUrl: string;
        workerId?: string;
      }) => Promise<DeviceConfigTestResult>;
    };
  };
}

/** main から返る マスク済み device 設定 (token は last4 のみ)。 */
type DeviceConfigMasked = {
  configured: boolean;
  deviceId?: string | null;
  deviceName?: string | null;
  apiUrl?: string | null;
  workerId?: string | null;
  configuredAt?: string | null;
  lastVerifiedAt?: string | null;
  tokenLast4?: string | null;
};

/** device 接続テストの結果 (token は含まない)。 */
type DeviceConfigTestResult = {
  ok: boolean;
  code: string;
  message?: string;
  /** overview API が返す shop 配列 (lib/salonboard.ts の DeviceOverviewShop 互換)。 */
  shops?: Array<{
    shop_id: string;
    shop_name: string;
    organization_id: string;
    credential_status: string;
    consent_status: string;
    sync_status: string;
    enabled: boolean;
    blocked_until: string | null;
    last_success_at: string | null;
    last_error_at: string | null;
    last_error_code: string | null;
    last_error_message: string | null;
    consecutive_failures: number;
  }>;
  device?: {
    id: string | null;
    organization_id: string | null;
    status: string | null;
    device_name: string | null;
    device_platform: string | null;
    app_version: string | null;
    last_seen_at: string | null;
  } | null;
};
