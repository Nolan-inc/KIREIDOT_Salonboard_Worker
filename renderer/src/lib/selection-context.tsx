import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { useAuth } from './auth-context';
import { supabase } from './supabase';
import type { StaffScope, ScopeRole } from './supabase';

/**
 * 「いま画面で見ている会社/店舗」を保持するコンテキスト。
 *
 * auth.scope は「ログインユーザーの所属」(= 閲覧可能範囲) を表す静的情報。
 * SelectionContext は「いまユーザーが操作対象として選んでいる」会社/店舗
 * を表す動的な UI 状態で、auth とは独立。
 *
 *   - super_owner / admin: 任意の組織・店舗を選択できる
 *   - owner: 所属組織内のどの店舗でも選択できる
 *   - shop_manager / staff: 自分の所属店舗のみ
 *
 * 選択結果は localStorage に保存し、次回起動時に復元する。
 * サインアウト時はクリアする (次のユーザーに前のユーザーの選択が引き継がれないように)。
 */

const LS_ORG_KEY = 'salondesk.selectedOrgId';
const LS_SHOP_KEY = 'salondesk.selectedShopId';

type SelectionContextValue = {
  selectedOrgId: string | null;
  selectedShopId: string | null;
  /** 会社を選択。null を渡すと選択解除 (店舗もクリア)。 */
  setSelectedOrg: (id: string | null) => void;
  /** 店舗を選択。 */
  setSelectedShop: (id: string | null) => void;
  /** 会社・店舗どちらもクリア。 */
  clear: () => void;
};

const SelectionContext = createContext<SelectionContextValue | null>(null);

function readStorage(key: string): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function writeStorage(key: string, value: string | null) {
  if (typeof window === 'undefined') return;
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* ignore */
  }
}

/** super_owner / admin は閲覧可能範囲が「全社」なので任意の組織を選べる。 */
function canPickAnyOrg(role: ScopeRole): boolean {
  return role === 'super_owner' || role === 'admin';
}

/** owner は所属組織内の任意の店舗、shop_manager/staff は自店舗のみ。 */
function canPickAnyShopInOrg(role: ScopeRole): boolean {
  return role === 'super_owner' || role === 'admin' || role === 'owner';
}

export function SelectionProvider({ children }: { children: ReactNode }) {
  const auth = useAuth();

  // 初期値は同期的に localStorage から読む (初回レンダーから復元済みにする)
  const [selectedOrgId, setSelectedOrgIdState] = useState<string | null>(() =>
    readStorage(LS_ORG_KEY),
  );
  const [selectedShopId, setSelectedShopIdState] = useState<string | null>(() =>
    readStorage(LS_SHOP_KEY),
  );

  // 永続化
  useEffect(() => {
    writeStorage(LS_ORG_KEY, selectedOrgId);
  }, [selectedOrgId]);
  useEffect(() => {
    writeStorage(LS_SHOP_KEY, selectedShopId);
  }, [selectedShopId]);

  const setSelectedOrg = useCallback((id: string | null) => {
    setSelectedOrgIdState((cur) => {
      // 違う組織に切り替えるなら店舗もクリア (前の組織の店舗が残らないように)
      if (cur !== id) setSelectedShopIdState(null);
      return id;
    });
  }, []);
  const setSelectedShop = useCallback((id: string | null) => {
    setSelectedShopIdState(id);
  }, []);
  const clear = useCallback(() => {
    setSelectedOrgIdState(null);
    setSelectedShopIdState(null);
  }, []);

  // auth 状態とのバリデーション/同期
  useEffect(() => {
    if (auth.status === 'signed-out') {
      // 次のユーザーに引き継がないよう完全クリア
      setSelectedOrgIdState(null);
      setSelectedShopIdState(null);
      return;
    }
    if (auth.status !== 'signed-in') return;

    const scope: StaffScope = auth.scope;

    // owner 以下のロールは閲覧可能組織が 1 つだけ → 永続化された値が違えば強制上書き
    if (!canPickAnyOrg(scope.role)) {
      if (scope.organizationId && selectedOrgId !== scope.organizationId) {
        setSelectedOrgIdState(scope.organizationId);
        // 店舗も付随してクリア (組織が変わったので)
        setSelectedShopIdState(null);
      }
    } else {
      // super_owner で永続化値が空なら、まず自分の所属組織をデフォルトに
      if (selectedOrgId === null && scope.organizationId) {
        setSelectedOrgIdState(scope.organizationId);
      }
    }

    // shop_manager / staff は自店舗固定
    if (!canPickAnyShopInOrg(scope.role)) {
      if (scope.shopId && selectedShopId !== scope.shopId) {
        setSelectedShopIdState(scope.shopId);
      }
    }
    // owner 以上で店舗が決まっていなくても強制はしない (店舗選択画面を見せる)
  }, [auth, selectedOrgId, selectedShopId]);

  const value = useMemo<SelectionContextValue>(
    () => ({
      selectedOrgId,
      selectedShopId,
      setSelectedOrg,
      setSelectedShop,
      clear,
    }),
    [selectedOrgId, selectedShopId, setSelectedOrg, setSelectedShop, clear],
  );

  return <SelectionContext.Provider value={value}>{children}</SelectionContext.Provider>;
}

export function useSelection(): SelectionContextValue {
  const ctx = useContext(SelectionContext);
  if (!ctx) throw new Error('SelectionProvider が見つかりません');
  return ctx;
}

/**
 * データ取得時に使う「実効スコープ」。
 * - organizationId / shopId は selection から取り (UI の選択を反映)
 * - role や id 系はそのまま auth.scope を引き継ぐ
 *
 * Provider 外 (auth が signed-in でない) では null を返す。呼び側はそのとき
 * クエリを発火しないこと (App.tsx 側でルートガードしている前提)。
 */
export function useEffectiveScope(): StaffScope | null {
  const auth = useAuth();
  const { selectedOrgId, selectedShopId } = useSelection();
  if (auth.status !== 'signed-in') return null;
  const base = auth.scope;
  return {
    ...base,
    organizationId: selectedOrgId ?? base.organizationId,
    shopId: selectedShopId ?? null,
  };
}

/**
 * 選択中の店舗のジャンル (hair / esthetic / nail / ...) を返す。
 * 未選択時は null。ラベルの出し分け (美容室=スタイリスト/スタイル 等) に使う。
 */
export function useSelectedShopGenre(): string | null {
  const { selectedShopId } = useSelection();
  const [genre, setGenre] = useState<string | null>(null);
  useEffect(() => {
    if (!selectedShopId) {
      setGenre(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      const { data } = await supabase
        .from('shops')
        .select('genre')
        .eq('id', selectedShopId)
        .maybeSingle();
      if (cancelled) return;
      setGenre(((data as any)?.genre ?? null) as string | null);
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedShopId]);
  return genre;
}

/** 美容室(hair)かどうかでラベルを出し分けるユーティリティ。 */
export function isHairGenre(genre: string | null | undefined): boolean {
  return genre === 'hair';
}
