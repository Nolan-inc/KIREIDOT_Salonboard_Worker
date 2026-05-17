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
  signOut: () => Promise<void>;
  reloadScope: () => Promise<void>;
};

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

  const signIn = useCallback<AuthContextValue['signIn']>(async (email, password) => {
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) return { error: error.message };
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
    () => ({ ...state, signIn, signOut, reloadScope }),
    [state, signIn, signOut, reloadScope],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('AuthProvider が見つかりません');
  return ctx;
}
