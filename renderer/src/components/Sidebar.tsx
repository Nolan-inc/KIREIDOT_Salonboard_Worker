import { useEffect, useState } from 'react';
import { Store, X } from 'lucide-react';
import { NAV_ITEMS, getVisibleNavKeys, navLabelForGenre, type NavKey } from '../lib/nav';
import { cn } from '../lib/cn';
import { useAuth } from '../lib/auth-context';
import { useSelection, useSelectedShopGenre } from '../lib/selection-context';
import { supabase } from '../lib/supabase';

export function Sidebar({
  active,
  onChange,
}: {
  active: NavKey;
  onChange: (k: NavKey) => void;
}) {
  const { selectedShopId } = useSelection();
  const genre = useSelectedShopGenre();
  const visibleKeys = new Set(getVisibleNavKeys(!!selectedShopId));
  const items = NAV_ITEMS.filter((i) => visibleKeys.has(i.key));

  return (
    <aside className="flex h-full w-[248px] flex-col border-r border-hairline/70 bg-white/55 backdrop-blur-md">
      {/* ロゴ + ドラッグ可能なヘッダー */}
      <div className="app-drag flex h-[64px] items-end px-5 pb-3">
        <div className="app-no-drag flex items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-[10px] bg-brand-gradient text-white shadow-brand-sm">
            <span className="font-serif text-[14px] font-bold leading-none">K</span>
          </div>
          <div className="flex flex-col leading-tight">
            <span className="font-serif text-[15px] font-bold tracking-wide text-ink">
              サロンデスク
            </span>
            <span className="text-[10px] tracking-[0.18em] text-brand-700">
              KIREIDOT
            </span>
          </div>
        </div>
      </div>

      {/* 選択中の店舗 (選択中のときだけ表示) */}
      <SelectedShopBanner />

      {/* ナビ */}
      <nav className="app-no-drag mt-2 flex-1 overflow-y-auto px-3">
        <ul className="flex flex-col gap-1">
          {items.map((item) => {
            const Icon = item.icon;
            const isActive = item.key === active;
            return (
              <li key={item.key}>
                <button
                  type="button"
                  onClick={() => onChange(item.key)}
                  className={cn(
                    'group flex w-full items-center gap-3 rounded-[12px] px-3 py-2.5 text-left transition-all',
                    isActive
                      ? 'bg-brand-gradient text-white shadow-brand-sm'
                      : 'text-ink-soft hover:bg-brand-light/60 hover:text-brand-700',
                  )}
                >
                  <span
                    className={cn(
                      'flex h-7 w-7 items-center justify-center rounded-[8px]',
                      isActive
                        ? 'bg-white/20 text-white'
                        : 'bg-brand-light/70 text-brand-700 group-hover:bg-white',
                    )}
                  >
                    <Icon className="h-3.5 w-3.5" />
                  </span>
                  <span
                    className={cn(
                      'flex-1 text-[13px] font-semibold',
                      isActive ? 'text-white' : '',
                    )}
                  >
                    {navLabelForGenre(item.key, item.label, genre)}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </nav>

      <Footer />
    </aside>
  );
}

/**
 * 「いま操作中の店舗」を表示するバナー。店舗が選択されていないときは何も表示しない。
 * バツボタンで選択を解除でき、選択解除すると店舗一覧画面に戻る (App.tsx 側のガードに任せる)。
 */
function SelectedShopBanner() {
  const { selectedShopId, setSelectedShop } = useSelection();
  const [shopName, setShopName] = useState<string | null>(null);

  useEffect(() => {
    if (!selectedShopId) {
      setShopName(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      const { data } = await supabase
        .from('shops')
        .select('name')
        .eq('id', selectedShopId)
        .maybeSingle();
      if (cancelled) return;
      setShopName(((data as any)?.name ?? null) as string | null);
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedShopId]);

  if (!selectedShopId) return null;

  return (
    <div className="app-no-drag mx-3 mt-3 flex items-center gap-2 rounded-[10px] border border-brand-200 bg-brand-light/50 px-2.5 py-2">
      <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-brand-gradient text-white">
        <Store className="h-3 w-3" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-[9px] uppercase tracking-wider text-brand-700/80">操作中の店舗</div>
        <div className="truncate text-[12px] font-semibold text-ink">
          {shopName ?? '読み込み中…'}
        </div>
      </div>
      <button
        type="button"
        onClick={() => setSelectedShop(null)}
        className="rounded-full p-1 text-ink-soft transition hover:bg-white hover:text-ink"
        title="店舗の選択を解除"
        aria-label="店舗の選択を解除"
      >
        <X className="h-3 w-3" />
      </button>
    </div>
  );
}

function Footer() {
  const auth = useAuth();
  const name =
    auth.status === 'signed-in'
      ? auth.scope.fullName ?? auth.scope.email ?? ''
      : '';
  const role = auth.status === 'signed-in' ? auth.scope.role : '';
  return (
    <div className="app-no-drag border-t border-hairline/60 px-4 py-3 text-[10px] text-muted">
      {auth.status === 'signed-in' && (
        <div className="mb-2 truncate text-[11px] font-semibold text-ink">
          {name}
          <span className="ml-1 text-[10px] font-normal text-muted">({role})</span>
        </div>
      )}
      <div className="flex items-center justify-between">
        <span>v {window.salondesk?.version ?? '0.0.0'}</span>
        <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-100/70 px-2 py-0.5 text-[10px] font-semibold text-emerald-700">
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
          接続済み
        </span>
      </div>
    </div>
  );
}
