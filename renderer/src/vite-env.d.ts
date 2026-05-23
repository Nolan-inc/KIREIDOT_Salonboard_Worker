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
  };
}
