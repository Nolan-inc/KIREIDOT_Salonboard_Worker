import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import type { Session } from '@supabase/supabase-js';
import { supabase, type StaffScope } from './supabase';

type AuthState =
  | { status: 'loading' }
  | { status: 'signed-out' }
  | { status: 'signed-in'; session: Session; scope: StaffScope };

type AuthContextValue = AuthState & {
  signIn: (email: string, password: string) => Promise<{ error: string | null }>;
  signInWithGoogle: () => Promise<{ error: string | null }>;
  signOut: () => Promise<void>;
  reloadScope: () => Promise<void>;
};

/**
 * Google OAuth で使う Deep Link コールバック先。
 * Supabase Dashboard → Auth → URL Configuration → Redirect URLs に
 * 同じ値を 1 行登録すること: kireidot-salondesk://auth/callback
 */
const OAUTH_REDIRECT_URL = 'kireidot-salondesk://auth/callback';

const AuthContext = createContext<AuthContextValue | null>(null);

async function loadScope(session: Session): Promise<StaffScope | null> {
  const userId = session.user.id;

  // staff レコード (本命)
  const { data: staffRow } = await supabase
    .from('staff')
    .select('id, profile_id, full_name, role, organization_id, shop_id')
    .eq('profile_id', userId)
    .eq('is_active', true)
    .maybeSingle();

  // profile (フォールバック / 表示用)
  const { data: profileRow } = await supabase
    .from('profiles')
    .select('id, full_name')
    .eq('id', userId)
    .maybeSingle();

  const orgId = (staffRow as any)?.organization_id ?? null;
  const shopId = (staffRow as any)?.shop_id ?? null;

  // 名前解決 (並列)
  const [orgRes, shopRes] = await Promise.all([
    orgId
      ? supabase.from('organizations').select('name').eq('id', orgId).maybeSingle()
      : Promise.resolve({ data: null as { name: string } | null }),
    shopId
      ? supabase.from('shops').select('name').eq('id', shopId).maybeSingle()
      : Promise.resolve({ data: null as { name: string } | null }),
  ]);

  return {
    userId,
    email: session.user.email ?? null,
    profileId: userId,
    staffId: (staffRow as any)?.id ?? null,
    fullName:
      (staffRow as any)?.full_name ??
      (profileRow as any)?.full_name ??
      session.user.email ??
      null,
    role: ((staffRow as any)?.role ?? 'user') as StaffScope['role'],
    organizationId: orgId,
    shopId,
    shopName: (shopRes.data as any)?.name ?? null,
    organizationName: (orgRes.data as any)?.name ?? null,
  };
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({ status: 'loading' });

  const applySession = useCallback(async (session: Session | null) => {
    if (!session) {
      setState({ status: 'signed-out' });
      return;
    }
    try {
      const scope = await loadScope(session);
      if (scope) {
        setState({ status: 'signed-in', session, scope });
      } else {
        setState({ status: 'signed-out' });
      }
    } catch (err) {
      console.error('[auth] loadScope failed:', err);
      setState({ status: 'signed-out' });
    }
  }, []);

  useEffect(() => {
    let mounted = true;
    supabase.auth.getSession().then(({ data }) => {
      if (mounted) void applySession(data.session ?? null);
    });
    const { data: listener } = supabase.auth.onAuthStateChange((_event, session) => {
      void applySession(session);
    });
    return () => {
      mounted = false;
      listener.subscription.unsubscribe();
    };
  }, [applySession]);

  // Electron main 経由で Deep Link (kireidot-salondesk://auth/callback?code=...) を受け取り、
  // PKCE フローを完了させてセッションを確立する。
  useEffect(() => {
    const bridge = typeof window !== 'undefined' ? window.kireidotApp : undefined;
    if (!bridge) return;
    const unsubscribe = bridge.onOAuthCallback(async (rawUrl) => {
      try {
        // url の query は protocol が独自スキームでも URLSearchParams で読める。
        const url = new URL(rawUrl);
        const code = url.searchParams.get('code');
        const errParam = url.searchParams.get('error');
        const errDesc = url.searchParams.get('error_description');
        if (errParam) {
          console.error('[auth] OAuth error from provider:', errParam, errDesc);
          setState({ status: 'signed-out' });
          return;
        }
        if (!code) return;
        const { error } = await supabase.auth.exchangeCodeForSession(code);
        if (error) {
          console.error('[auth] exchangeCodeForSession failed:', error);
          setState({ status: 'signed-out' });
        }
        // セッション成立は onAuthStateChange 経由で applySession に流れる
      } catch (err) {
        console.error('[auth] OAuth callback handling failed:', err);
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

  const signIn = useCallback<AuthContextValue['signIn']>(async (email, password) => {
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) return { error: error.message };
    return { error: null };
  }, []);

  const signInWithGoogle = useCallback<AuthContextValue['signInWithGoogle']>(async () => {
    const bridge = typeof window !== 'undefined' ? window.kireidotApp : undefined;
    if (!bridge) {
      return {
        error: 'Electron 環境で起動してください (Google ログインは Web 版では使えません)。',
      };
    }
    // PKCE フロー: Supabase が生成した認可 URL をシステムブラウザで開き、
    // 認可完了後に kireidot-salondesk://auth/callback?code=... が
    // 当アプリに deep link で返る。
    const { data, error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: OAUTH_REDIRECT_URL,
        skipBrowserRedirect: true,
      },
    });
    if (error) return { error: error.message };
    if (!data?.url) return { error: 'Google 認可 URL の取得に失敗しました。' };

    const res = await bridge.openExternal(data.url);
    if (!res?.ok) {
      return { error: `ブラウザを開けませんでした: ${res?.error ?? 'unknown'}` };
    }
    // 以降は preload 経由の 'oauth:callback' リスナー (useEffect 内) が
    // code を受け取って exchangeCodeForSession を呼ぶ。
    return { error: null };
  }, []);

  const signOut = useCallback(async () => {
    await supabase.auth.signOut();
  }, []);

  const reloadScope = useCallback(async () => {
    const { data } = await supabase.auth.getSession();
    await applySession(data.session ?? null);
  }, [applySession]);

  const value = useMemo<AuthContextValue>(
    () => ({ ...state, signIn, signInWithGoogle, signOut, reloadScope }),
    [state, signIn, signInWithGoogle, signOut, reloadScope],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('AuthProvider が見つかりません');
  return ctx;
}
