import { useEffect, useState } from 'react';
import {
  ArrowRight,
  Building2,
  CheckCircle2,
  Loader2,
  Store,
  TriangleAlert,
} from 'lucide-react';
import { Card, CardBody, CardHeader } from '../components/Card';
import { supabase } from '../lib/supabase';
import { useSelection } from '../lib/selection-context';
import { useAuth } from '../lib/auth-context';
import {
  fetchCredentialOverview,
  setSalonboardCredentialEnabled,
  setSalonboardSyncDirection,
  type CredentialOverviewRow,
} from '../lib/salonboard';
import type { NavKey } from '../lib/nav';

type ShopRow = {
  id: string;
  name: string;
  organization_id: string;
  address: string | null;
};

/**
 * 選択中の組織内の店舗一覧。クリックで店舗を選択し、ダッシュボードへ遷移する。
 *
 * 表示する付帯情報:
 *   - サロンボード連携の状態 (連携中 / 未設定 / エラー中)
 *   - 最終同期成功日時
 */
export function ShopList({ onPickShop }: { onPickShop: (key: NavKey) => void }) {
  const auth = useAuth();
  const { selectedOrgId, setSelectedShop } = useSelection();
  const [shops, setShops] = useState<ShopRow[]>([]);
  const [credByShop, setCredByShop] = useState<Map<string, CredentialOverviewRow>>(
    new Map(),
  );
  const [loading, setLoading] = useState(true);
  const [orgName, setOrgName] = useState<string | null>(null);

  useEffect(() => {
    if (!selectedOrgId) {
      setShops([]);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    void (async () => {
      const [shopsRes, credRows, orgRes] = await Promise.all([
        supabase
          .from('shops')
          .select('id, name, organization_id, address')
          .eq('organization_id', selectedOrgId)
          .order('name'),
        fetchCredentialOverview(),
        supabase
          .from('organizations')
          .select('name')
          .eq('id', selectedOrgId)
          .maybeSingle(),
      ]);
      if (cancelled) return;
      if (shopsRes.error) {
        console.warn('[shoplist] fetch shops error:', shopsRes.error.message);
        setShops([]);
      } else {
        setShops((shopsRes.data ?? []) as ShopRow[]);
      }
      const map = new Map<string, CredentialOverviewRow>();
      for (const r of credRows) {
        if (r.organization_id === selectedOrgId) map.set(r.shop_id, r);
      }
      setCredByShop(map);
      setOrgName(((orgRes.data as any)?.name ?? null) as string | null);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedOrgId]);

  function pick(shopId: string) {
    setSelectedShop(shopId);
    onPickShop('dashboard');
  }

  // 連携トグルの楽観更新 (credByShop の該当行を書き換える)
  function patchCred(shopId: string, patch: Partial<CredentialOverviewRow>) {
    setCredByShop((prev) => {
      const next = new Map(prev);
      const cur = next.get(shopId);
      if (cur) next.set(shopId, { ...cur, ...patch });
      return next;
    });
  }

  if (!selectedOrgId) {
    return (
      <div className="flex flex-col gap-5 pt-4">
        <Card>
          <CardBody className="flex flex-col items-center gap-3 py-12 text-center">
            <span className="inline-flex h-12 w-12 items-center justify-center rounded-full bg-brand-light text-brand-700">
              <Building2 className="h-5 w-5" />
            </span>
            <div className="text-[14px] font-semibold text-ink">会社が選択されていません</div>
            <p className="max-w-[40ch] text-[12px] text-ink-soft">
              右上の会社名をクリックして、操作対象の会社を選んでください。
              {auth.status === 'signed-in' &&
                auth.scope.role !== 'super_owner' &&
                auth.scope.role !== 'admin' &&
                '（あなたのアカウントは所属会社のみ表示されます。）'}
            </p>
          </CardBody>
        </Card>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5 pt-4">
      <Card>
        <CardHeader
          title={orgName ?? '店舗一覧'}
          subtitle="操作する店舗を 1 つ選んでください。選択するとダッシュボード・予約・スタッフ・シフト・ブログがその店舗のものになります。"
        />
        <CardBody>
          {loading ? (
            <div className="flex items-center gap-2 py-8 text-[12px] text-ink-soft">
              <Loader2 className="h-4 w-4 animate-spin" /> 読み込み中…
            </div>
          ) : shops.length === 0 ? (
            <p className="py-8 text-center text-[12px] text-ink-soft">
              この会社には店舗が登録されていません。
            </p>
          ) : (
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
              {shops.map((s) => {
                const cred = credByShop.get(s.id);
                return (
                  <div
                    key={s.id}
                    role="button"
                    tabIndex={0}
                    onClick={() => pick(s.id)}
                    onKeyDown={(e) => { if (e.key === 'Enter') pick(s.id); }}
                    className="group flex cursor-pointer flex-col items-start gap-2 rounded-[14px] border border-hairline bg-white/85 p-4 text-left transition hover:-translate-y-0.5 hover:border-brand-300 hover:shadow-card"
                  >
                    <div className="flex w-full items-start gap-3">
                      <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-brand-gradient text-white shadow-brand-sm">
                        <Store className="h-4 w-4" />
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-[14px] font-semibold text-ink">
                          {s.name}
                        </div>
                        {s.address && (
                          <div className="mt-0.5 truncate text-[11px] text-ink-soft">
                            {s.address}
                          </div>
                        )}
                      </div>
                      <ArrowRight className="mt-1 h-4 w-4 text-ink-soft transition group-hover:translate-x-0.5 group-hover:text-brand-700" />
                    </div>

                    <ShopCredBadge cred={cred} />
                    {cred?.has_credential && (
                      <SyncToggles shopId={s.id} cred={cred} onPatch={patchCred} />
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </CardBody>
      </Card>
    </div>
  );
}

// 店舗カード内の連携トグル: 連携(全体) / 取得 / 登録 を個別 ON/OFF。
// カードのクリック(店舗選択)と分離するため stopPropagation する。
function SyncToggles({
  shopId,
  cred,
  onPatch,
}: {
  shopId: string;
  cred: CredentialOverviewRow;
  onPatch: (shopId: string, patch: Partial<CredentialOverviewRow>) => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const enabled = cred.enabled !== false;
  const fetchOn = cred.sync_fetch_enabled !== false;
  const pushOn = cred.sync_push_enabled !== false;

  const Chip = ({
    label,
    on,
    disabled,
    onToggle,
  }: {
    label: string;
    on: boolean;
    disabled?: boolean;
    onToggle: () => void;
  }) => (
    <span
      role="button"
      tabIndex={0}
      aria-disabled={disabled || busy === label}
      onClick={(e) => {
        e.stopPropagation();
        if (!disabled && busy !== label) onToggle();
      }}
      title={`${label}: ${on ? 'ON（クリックでOFF）' : 'OFF（クリックでON）'}`}
      className={
        'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-semibold transition ' +
        (disabled
          ? 'cursor-not-allowed border-hairline text-muted opacity-50'
          : on
            ? 'border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-100 cursor-pointer'
            : 'border-hairline bg-white text-ink-soft hover:bg-brand-light/40 cursor-pointer')
      }
    >
      <span className={'h-1.5 w-1.5 rounded-full ' + (on && !disabled ? 'bg-emerald-500' : 'bg-zinc-300')} />
      {busy === label ? '…' : label}
    </span>
  );

  return (
    <div className="mt-1 flex flex-wrap items-center gap-1.5">
      <Chip
        label="連携"
        on={enabled}
        onToggle={async () => {
          setBusy('連携');
          const next = !enabled;
          const r = await setSalonboardCredentialEnabled(shopId, next);
          if (r.ok) onPatch(shopId, { enabled: next });
          setBusy(null);
        }}
      />
      <Chip
        label="取得"
        on={fetchOn}
        disabled={!enabled}
        onToggle={async () => {
          setBusy('取得');
          const next = !fetchOn;
          const r = await setSalonboardSyncDirection(shopId, 'fetch', next);
          if (r.ok) onPatch(shopId, { sync_fetch_enabled: next });
          setBusy(null);
        }}
      />
      <Chip
        label="登録"
        on={pushOn}
        disabled={!enabled}
        onToggle={async () => {
          setBusy('登録');
          const next = !pushOn;
          const r = await setSalonboardSyncDirection(shopId, 'push', next);
          if (r.ok) onPatch(shopId, { sync_push_enabled: next });
          setBusy(null);
        }}
      />
    </div>
  );
}

function ShopCredBadge({ cred }: { cred: CredentialOverviewRow | undefined }) {
  if (!cred || !cred.has_credential) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-semibold text-amber-700">
        <TriangleAlert className="h-2.5 w-2.5" /> サロンボード未設定
      </span>
    );
  }
  if ((cred.consecutive_failures ?? 0) > 0) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-red-50 px-2 py-0.5 text-[10px] font-semibold text-red-700">
        <TriangleAlert className="h-2.5 w-2.5" /> エラー中 ({cred.consecutive_failures})
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-semibold text-emerald-700">
      <CheckCircle2 className="h-2.5 w-2.5" />
      {cred.last_success_at
        ? `最終同期: ${new Date(cred.last_success_at).toLocaleString('ja-JP', {
            month: 'numeric',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
          })}`
        : '連携中'}
    </span>
  );
}
