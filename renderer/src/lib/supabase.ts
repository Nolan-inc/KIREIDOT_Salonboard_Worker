import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!url || !anonKey) {
  // 起動時に致命的だが、UI 側でハンドリングするためここでは throw しない
  console.warn('[supabase] VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY が未設定です。.env.local を確認してください。');
}

/**
 * Supabase Auth セッション保存先 (v0.2.9 で導入)。
 *
 * 本番ビルド (.app) は file:// オリジンで起動するため localStorage が
 * 安定して維持できず、毎回ログアウトされる問題があった。
 * Electron 側 (main process) の userData/auth-storage.json に保存する
 * IPC を contextBridge 経由で window.kireidotApp.authStorage として
 * expose してあるので、それをこの client の storage に渡す。
 *
 * 開発時 (npm run dev → http://localhost:5173) は bridge が無い場合に
 * フォールバックとして window.localStorage を使う。
 */
const bridge = typeof window !== 'undefined' ? window.kireidotApp : undefined;
const authStorageImpl = bridge?.authStorage
  ? {
      async getItem(key: string): Promise<string | null> {
        try {
          return await bridge.authStorage!.getItem(key);
        } catch {
          return null;
        }
      },
      async setItem(key: string, value: string): Promise<void> {
        try {
          await bridge.authStorage!.setItem(key, value);
        } catch {
          /* ignore */
        }
      },
      async removeItem(key: string): Promise<void> {
        try {
          await bridge.authStorage!.removeItem(key);
        } catch {
          /* ignore */
        }
      },
    }
  : undefined; // 未定義なら supabase は localStorage にフォールバック

export const supabase = createClient(url ?? '', anonKey ?? '', {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    // Electron 上では window.location ベースの自動セッション復元は使わない。
    // OAuth コールバックは Deep Link (kireidot-salondesk://...) → IPC で受け取り、
    // 明示的に exchangeCodeForSession() を呼ぶ。
    detectSessionInUrl: false,
    // Google OAuth を Deep Link で受け取るために PKCE フローを使う。
    flowType: 'pkce',
    // 本番 .app では userData ベース、開発時は localStorage にフォールバック。
    ...(authStorageImpl ? { storage: authStorageImpl as any } : {}),
    // ストレージ内のキー名を固定 (デフォルトは 'sb-<project>-auth-token')。
    // 同じ key を main/preload 側でも参照する想定。
    storageKey: 'kireidot-salondesk-auth',
  },
});

export type ScopeRole =
  | 'super_owner'
  | 'admin'
  | 'owner'
  | 'shop_manager'
  | 'staff'
  | 'user';

export type StaffScope = {
  userId: string;
  email: string | null;
  profileId: string;
  staffId: string | null;
  fullName: string | null;
  role: ScopeRole;
  organizationId: string | null;
  shopId: string | null;
  shopName: string | null;
  organizationName: string | null;
};
