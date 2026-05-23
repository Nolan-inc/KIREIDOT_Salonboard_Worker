import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!url || !anonKey) {
  // 起動時に致命的だが、UI 側でハンドリングするためここでは throw しない
  console.warn('[supabase] VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY が未設定です。.env.local を確認してください。');
}

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
