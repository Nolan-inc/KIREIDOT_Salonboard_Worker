import { useEffect, useRef, useState } from 'react';
import { Building2, Check, ChevronDown } from 'lucide-react';
import { useAuth } from '../lib/auth-context';
import { useSelection } from '../lib/selection-context';
import { supabase } from '../lib/supabase';

type OrgRow = { id: string; name: string };

/**
 * 会社切替チップ。クリックでドロップダウンを開き、選択中の組織を変更する。
 *
 *  - super_owner / admin: すべての organizations を一覧表示
 *  - owner / shop_manager / staff: 自分の所属組織のみ (1 件)。切替不可。
 */
export function OrgSwitcher() {
  const auth = useAuth();
  const { selectedOrgId, setSelectedOrg } = useSelection();
  const [open, setOpen] = useState(false);
  const [orgs, setOrgs] = useState<OrgRow[]>([]);
  const [loading, setLoading] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  const canSwitch =
    auth.status === 'signed-in' &&
    (auth.scope.role === 'super_owner' || auth.scope.role === 'admin');

  // 切替可能なロールのときだけ全 organizations を取得
  useEffect(() => {
    if (!canSwitch || auth.status !== 'signed-in') return;
    let cancelled = false;
    setLoading(true);
    void (async () => {
      const { data, error } = await supabase
        .from('organizations')
        .select('id, name')
        .order('name');
      if (cancelled) return;
      if (error) {
        console.warn('[org-switcher] fetch organizations error:', error.message);
        setOrgs([]);
      } else {
        setOrgs((data ?? []) as OrgRow[]);
      }
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [canSwitch, auth.status]);

  // 切替不可ロールの場合は自分の組織だけをリストとして持っておく
  useEffect(() => {
    if (canSwitch) return;
    if (auth.status !== 'signed-in') return;
    const { organizationId, organizationName } = auth.scope;
    if (organizationId) {
      setOrgs([{ id: organizationId, name: organizationName ?? '(組織名未設定)' }]);
    }
  }, [canSwitch, auth]);

  // 外側クリックで閉じる
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current) return;
      if (!wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [open]);

  if (auth.status !== 'signed-in') return null;

  const initial = (auth.scope.fullName ?? auth.scope.email ?? 'U').slice(0, 1);
  const currentOrgName =
    orgs.find((o) => o.id === selectedOrgId)?.name ??
    auth.scope.organizationName ??
    '会社を選択';

  return (
    <div ref={wrapRef} className="relative">
      <button
        type="button"
        disabled={!canSwitch}
        onClick={() => canSwitch && setOpen((v) => !v)}
        className={
          'ml-2 inline-flex h-9 items-center gap-2 rounded-full border border-hairline bg-white/80 pl-1.5 pr-3 transition ' +
          (canSwitch ? 'hover:bg-brand-light/40 cursor-pointer' : 'cursor-default')
        }
        title={canSwitch ? '会社を切り替える' : '所属会社'}
      >
        <span className="flex h-6 w-6 items-center justify-center rounded-full bg-brand-gradient text-[10px] font-bold text-white">
          {initial}
        </span>
        <span className="max-w-[180px] truncate text-[12px] font-semibold text-ink">
          {currentOrgName}
        </span>
        {canSwitch && <ChevronDown className="h-3 w-3 text-ink-soft" />}
      </button>

      {open && canSwitch && (
        <div className="absolute right-0 top-[calc(100%+6px)] z-50 w-72 rounded-[12px] border border-hairline bg-white/95 shadow-card backdrop-blur-md">
          <div className="border-b border-hairline/60 px-3 py-2 text-[10px] uppercase tracking-wider text-muted">
            会社を選択
          </div>
          <div className="max-h-72 overflow-y-auto py-1">
            {loading ? (
              <div className="px-3 py-3 text-[11px] text-ink-soft">読み込み中…</div>
            ) : orgs.length === 0 ? (
              <div className="px-3 py-3 text-[11px] text-ink-soft">会社がありません。</div>
            ) : (
              <ul className="flex flex-col">
                {orgs.map((o) => {
                  const active = o.id === selectedOrgId;
                  return (
                    <li key={o.id}>
                      <button
                        type="button"
                        onClick={() => {
                          setSelectedOrg(o.id);
                          setOpen(false);
                        }}
                        className={
                          'flex w-full items-center gap-2 px-3 py-2 text-left text-[12.5px] transition ' +
                          (active
                            ? 'bg-brand-light/60 text-brand-700 font-semibold'
                            : 'text-ink hover:bg-brand-light/30')
                        }
                      >
                        <Building2 className="h-3.5 w-3.5 shrink-0 text-brand-700" />
                        <span className="flex-1 truncate">{o.name}</span>
                        {active && <Check className="h-3.5 w-3.5 text-brand-700" />}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
