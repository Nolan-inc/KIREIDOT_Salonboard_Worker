import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  AlertTriangle,
  Building2,
  CheckCircle2,
  Database,
  Eye,
  FileText,
  Key,
  Loader2,
  LogOut,
  Play,
  RefreshCcw,
  ShieldCheck,
  Store,
  User,
} from 'lucide-react';
import { Card, CardBody, CardHeader } from '../components/Card';
import { useAuth } from '../lib/auth-context';
import {
  DEFAULT_SYNC_TARGETS,
  defaultApiUrl,
  fetchSalonboardOrganizations,
  runLocalSalonboardSync,
  saveSalonboardCredentials,
  type SalonboardOrganization,
  type SalonboardShop,
  type SalonboardSyncResult,
  type SyncTargets,
} from '../lib/salonboard';

const TARGET_LABELS: Record<keyof SyncTargets, string> = {
  bookings: '予約一覧',
  staff: 'スタッフ',
  shifts: 'シフト',
  blogs: 'ブログ',
};

export function Settings() {
  const auth = useAuth();
  const [apiUrl, setApiUrl] = useState(defaultApiUrl());
  const [organizations, setOrganizations] = useState<SalonboardOrganization[]>([]);
  const [selectedOrgId, setSelectedOrgId] = useState('');
  const [selectedShopId, setSelectedShopId] = useState('');
  const [targets, setTargets] = useState<SyncTargets>(DEFAULT_SYNC_TARGETS);
  const [showBrowser, setShowBrowser] = useState(false);
  const [credentialLoginId, setCredentialLoginId] = useState('');
  const [credentialPassword, setCredentialPassword] = useState('');
  const [credentialBaseUrl, setCredentialBaseUrl] = useState('https://salonboard.com/login/');
  const [syncIntervalMinutes, setSyncIntervalMinutes] = useState(15);
  const [loadingOrgs, setLoadingOrgs] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [savingCredentials, setSavingCredentials] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [result, setResult] = useState<SalonboardSyncResult | null>(null);

  const signedIn = auth.status === 'signed-in';
  const accessToken = signedIn ? auth.session.access_token : null;

  const selectedOrg = useMemo(
    () => organizations.find((org) => org.id === selectedOrgId) ?? null,
    [organizations, selectedOrgId],
  );
  const selectedShop = useMemo(
    () => selectedOrg?.shops.find((shop) => shop.id === selectedShopId) ?? null,
    [selectedOrg, selectedShopId],
  );

  const canManageCredentials =
    auth.status === 'signed-in' && ['super_owner', 'admin', 'owner', 'shop_manager'].includes(auth.scope.role);
  const hasAnyTarget = Object.values(targets).some(Boolean);
  const canSync = signedIn && !!selectedShopId && !!selectedShop?.has_credentials && hasAnyTarget && !syncing;
  const canSaveCredentials =
    canManageCredentials &&
    !!selectedShopId &&
    credentialLoginId.trim().length > 0 &&
    credentialPassword.length > 0 &&
    !savingCredentials;

  useEffect(() => {
    if (auth.status !== 'signed-in') return;
    const token = auth.session.access_token;
    const scopedShopId = auth.scope.shopId;
    const scopedOrgId = auth.scope.organizationId;
    let cancelled = false;

    async function load() {
      setLoadingOrgs(true);
      setMessage(null);
      try {
        const orgs = await fetchSalonboardOrganizations(apiUrl, token);
        if (cancelled) return;
        setOrganizations(orgs);

        const firstOrg =
          orgs.find((org) => org.id === scopedOrgId) ??
          orgs.find((org) => org.shops.some((shop) => shop.has_credentials)) ??
          orgs[0] ??
          null;
        const firstShop =
          firstOrg?.shops.find((shop) => shop.id === scopedShopId) ??
          firstOrg?.shops.find((shop) => shop.has_credentials) ??
          firstOrg?.shops[0] ??
          null;
        setSelectedOrgId(firstOrg?.id ?? '');
        setSelectedShopId(firstShop?.id ?? '');
      } catch (e) {
        if (!cancelled) setMessage(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoadingOrgs(false);
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [signedIn, accessToken, apiUrl, auth.status === 'signed-in' ? auth.scope.shopId : null]);

  function toggleTarget(key: keyof SyncTargets) {
    setTargets((current) => ({ ...current, [key]: !current[key] }));
  }

  async function reloadOrganizations() {
    if (!signedIn || !accessToken) return;
    setLoadingOrgs(true);
    setMessage(null);
    try {
      const orgs = await fetchSalonboardOrganizations(apiUrl, accessToken);
      setOrganizations(orgs);
      if (!orgs.some((org) => org.id === selectedOrgId)) {
        setSelectedOrgId(orgs[0]?.id ?? '');
        setSelectedShopId(orgs[0]?.shops[0]?.id ?? '');
      }
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    } finally {
      setLoadingOrgs(false);
    }
  }

  async function startSync() {
    if (!signedIn || !accessToken || !selectedShopId) return;
    setSyncing(true);
    setMessage(null);
    setResult(null);
    try {
      const syncResult = await runLocalSalonboardSync({
        apiUrl,
        accessToken,
        shopId: selectedShopId,
        targets,
        showBrowser,
      });
      setResult(syncResult);
      setMessage(syncResult.ok ? '同期が完了しました。' : '一部の同期に失敗しました。ログを確認してください。');
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    } finally {
      setSyncing(false);
    }
  }

  async function saveCredentials() {
    if (!signedIn || !accessToken || !selectedShopId) return;
    setSavingCredentials(true);
    setMessage(null);
    try {
      await saveSalonboardCredentials({
        apiUrl,
        accessToken,
        shopId: selectedShopId,
        loginId: credentialLoginId,
        password: credentialPassword,
        baseUrl: credentialBaseUrl,
        syncIntervalMinutes,
      });
      setCredentialPassword('');
      await reloadOrganizations();
      setMessage('SalonBoard 認証情報を保存しました。');
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    } finally {
      setSavingCredentials(false);
    }
  }

  return (
    <div className="flex flex-col gap-5 pt-4">
      <Card>
        <CardHeader title="アカウント" subtitle="このアプリでログイン中のスタッフ情報" />
        <CardBody className="space-y-3">
          {signedIn ? (
            <>
              <Field label="氏名" value={auth.scope.fullName ?? '-'} icon={<User className="h-4 w-4" />} />
              <Field label="メール" value={auth.scope.email ?? '-'} />
              <Field label="ロール" value={auth.scope.role} />
              <Field label="所属組織" value={auth.scope.organizationName ?? '-'} />
              <Field label="所属店舗" value={auth.scope.shopName ?? '-'} />
              <button
                type="button"
                onClick={() => auth.signOut()}
                className="mt-2 inline-flex items-center gap-2 rounded-[10px] border border-red-200 bg-red-50 px-4 py-2 text-[12px] font-semibold text-red-700 hover:bg-red-100"
              >
                <LogOut className="h-3.5 w-3.5" /> ログアウト
              </button>
            </>
          ) : (
            <p className="text-[13px] text-ink-soft">未ログインです。</p>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="サロンボード連携"
          subtitle="会社と店舗を選び、保存済みのサロンボード ID / パスワードで取得します"
        />
        <CardBody className="space-y-4">
          <div className="grid gap-3 lg:grid-cols-[1.2fr_1fr]">
            <label className="block rounded-[12px] border border-hairline bg-white/85 px-3 py-2">
              <span className="text-[10px] uppercase tracking-wider text-muted">KIREIDOT Admin URL</span>
              <input
                value={apiUrl}
                onChange={(e) => setApiUrl(e.target.value)}
                className="mt-1 h-8 w-full bg-transparent text-[13px] font-semibold text-ink outline-none"
                placeholder="http://localhost:3000"
              />
            </label>
            <button
              type="button"
              onClick={reloadOrganizations}
              disabled={!signedIn || loadingOrgs}
              className="inline-flex items-center justify-center gap-2 rounded-[12px] border border-hairline bg-white/80 px-4 py-2 text-[12px] font-semibold text-ink-soft hover:bg-brand-light/40 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {loadingOrgs ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCcw className="h-3.5 w-3.5" />}
              会社・店舗を再取得
            </button>
          </div>

          <div className="grid gap-3 lg:grid-cols-2">
            <label className="block rounded-[12px] border border-hairline bg-white/85 px-3 py-2">
              <span className="inline-flex items-center gap-1 text-[10px] uppercase tracking-wider text-muted">
                <Building2 className="h-3 w-3" /> 会社
              </span>
              <select
                value={selectedOrgId}
                onChange={(e) => {
                  const orgId = e.target.value;
                  const org = organizations.find((item) => item.id === orgId);
                  setSelectedOrgId(orgId);
                  setSelectedShopId(org?.shops.find((shop) => shop.has_credentials)?.id ?? org?.shops[0]?.id ?? '');
                }}
                className="mt-1 h-8 w-full bg-transparent text-[13px] font-semibold text-ink outline-none"
              >
                {organizations.length === 0 ? (
                  <option value="">会社がありません</option>
                ) : (
                  organizations.map((org) => (
                    <option key={org.id} value={org.id}>
                      {org.name}
                    </option>
                  ))
                )}
              </select>
            </label>

            <label className="block rounded-[12px] border border-hairline bg-white/85 px-3 py-2">
              <span className="inline-flex items-center gap-1 text-[10px] uppercase tracking-wider text-muted">
                <Store className="h-3 w-3" /> 店舗
              </span>
              <select
                value={selectedShopId}
                onChange={(e) => setSelectedShopId(e.target.value)}
                className="mt-1 h-8 w-full bg-transparent text-[13px] font-semibold text-ink outline-none"
              >
                {!selectedOrg || selectedOrg.shops.length === 0 ? (
                  <option value="">店舗がありません</option>
                ) : (
                  selectedOrg.shops.map((shop) => (
                    <option key={shop.id} value={shop.id}>
                      {shop.name}
                    </option>
                  ))
                )}
              </select>
            </label>
          </div>

          <ConnectionStatus shop={selectedShop} />

          <div className="rounded-[14px] border border-hairline bg-white/75 p-3">
            <div className="mb-3 flex items-center justify-between gap-2">
              <div>
                <div className="text-[13px] font-bold text-ink">SalonBoard ID / パスワード登録</div>
                <div className="text-[11px] text-ink-soft">選択中の店舗に紐づく認証情報を暗号化保存します。</div>
              </div>
              <Key className="h-4 w-4 text-brand-700" />
            </div>
            <div className="grid gap-3 md:grid-cols-2">
              <label className="block rounded-[10px] border border-hairline bg-white px-3 py-2">
                <span className="text-[10px] uppercase tracking-wider text-muted">ログイン ID</span>
                <input
                  value={credentialLoginId}
                  onChange={(e) => setCredentialLoginId(e.target.value)}
                  className="mt-1 h-8 w-full bg-transparent text-[13px] font-semibold text-ink outline-none"
                  placeholder="SalonBoard ID"
                />
              </label>
              <label className="block rounded-[10px] border border-hairline bg-white px-3 py-2">
                <span className="text-[10px] uppercase tracking-wider text-muted">パスワード</span>
                <input
                  type="password"
                  value={credentialPassword}
                  onChange={(e) => setCredentialPassword(e.target.value)}
                  className="mt-1 h-8 w-full bg-transparent text-[13px] font-semibold text-ink outline-none"
                  placeholder="保存時のみ入力"
                />
              </label>
              <label className="block rounded-[10px] border border-hairline bg-white px-3 py-2 md:col-span-2">
                <span className="text-[10px] uppercase tracking-wider text-muted">ログイン URL</span>
                <input
                  value={credentialBaseUrl}
                  onChange={(e) => setCredentialBaseUrl(e.target.value)}
                  className="mt-1 h-8 w-full bg-transparent text-[13px] font-semibold text-ink outline-none"
                  placeholder="https://salonboard.com/login/"
                />
              </label>
              <label className="block rounded-[10px] border border-hairline bg-white px-3 py-2">
                <span className="text-[10px] uppercase tracking-wider text-muted">自動同期目安</span>
                <input
                  type="number"
                  min={5}
                  max={120}
                  value={syncIntervalMinutes}
                  onChange={(e) => setSyncIntervalMinutes(Number(e.target.value))}
                  className="mt-1 h-8 w-full bg-transparent text-[13px] font-semibold text-ink outline-none"
                />
              </label>
              <button
                type="button"
                onClick={saveCredentials}
                disabled={!canSaveCredentials}
                className="inline-flex items-center justify-center gap-2 rounded-[12px] bg-brand-gradient px-4 py-2 text-[12px] font-bold text-white shadow-brand-sm disabled:cursor-not-allowed disabled:opacity-50"
              >
                {savingCredentials ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ShieldCheck className="h-3.5 w-3.5" />}
                認証情報を保存
              </button>
            </div>
            {!canManageCredentials && (
              <div className="mt-2 text-[11px] font-semibold text-amber-700">
                認証情報の登録は owner / shop_manager / admin / super_owner のみ可能です。
              </div>
            )}
          </div>

          {selectedOrg && selectedOrg.shops.length > 0 && (
            <div className="grid grid-cols-1 gap-2 md:grid-cols-2 xl:grid-cols-3">
              {selectedOrg.shops.map((shop) => (
                <button
                  key={shop.id}
                  type="button"
                  onClick={() => setSelectedShopId(shop.id)}
                  className={
                    selectedShopId === shop.id
                      ? 'rounded-[12px] border border-brand-300 bg-brand-light/60 p-3 text-left shadow-brand-sm'
                      : 'rounded-[12px] border border-hairline bg-white/75 p-3 text-left hover:bg-brand-light/30'
                  }
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[13px] font-bold text-ink">{shop.name}</span>
                    <CredentialBadge shop={shop} />
                  </div>
                  <div className="mt-1 text-[10px] text-muted">{shop.id}</div>
                </button>
              ))}
            </div>
          )}

          {message && (
            <div className="rounded-[12px] border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] font-semibold text-amber-800">
              {message}
            </div>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="同期実行" subtitle="選択中の店舗から予約・スタッフ・シフト・ブログを取得します" />
        <CardBody className="space-y-4">
          <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
            {(Object.keys(TARGET_LABELS) as Array<keyof SyncTargets>).map((key) => (
              <ToggleChip
                key={key}
                icon={targetIcon(key)}
                label={TARGET_LABELS[key]}
                on={targets[key]}
                onClick={() => toggleTarget(key)}
              />
            ))}
          </div>

          <ToggleRow
            icon={<Eye className="h-4 w-4" />}
            label="ブラウザを表示"
            description="取得に失敗する場合だけ ON にして、SalonBoard の実画面を確認します"
            on={showBrowser}
            onClick={() => setShowBrowser((v) => !v)}
          />

          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <button
              type="button"
              disabled={!canSync}
              onClick={startSync}
              className="inline-flex h-11 items-center justify-center gap-2 rounded-[14px] bg-brand-gradient px-5 text-[13px] font-bold text-white shadow-brand-sm transition hover:shadow-brand disabled:cursor-not-allowed disabled:opacity-50"
            >
              {syncing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
              サロンボードから同期する
            </button>
            {!selectedShop?.has_credentials && (
              <p className="text-[11px] text-amber-700">
                この店舗には SalonBoard 認証情報が登録されていません。上のフォームで ID / パスワードを登録してください。
              </p>
            )}
          </div>

          {result && <SyncResult result={result} />}
        </CardBody>
      </Card>
    </div>
  );
}

function ConnectionStatus({ shop }: { shop: SalonboardShop | null }) {
  if (!shop) {
    return (
      <div className="flex items-center gap-3 rounded-[12px] bg-slate-50 p-3">
        <AlertTriangle className="h-5 w-5 text-slate-500" />
        <div>
          <div className="text-[13px] font-semibold text-slate-700">店舗未選択</div>
          <div className="text-[11px] text-slate-600">会社と店舗を選択してください。</div>
        </div>
      </div>
    );
  }
  if (!shop.has_credentials) {
    return (
      <div className="flex items-center gap-3 rounded-[12px] bg-amber-50 p-3">
        <ShieldCheck className="h-5 w-5 text-amber-600" />
        <div>
          <div className="text-[13px] font-semibold text-amber-700">未接続</div>
          <div className="text-[11px] text-amber-700/80">この店舗の SalonBoard ID / パスワードが未登録です。</div>
        </div>
      </div>
    );
  }
  return (
    <div className="flex items-center gap-3 rounded-[12px] bg-emerald-50 p-3">
      <CheckCircle2 className="h-5 w-5 text-emerald-600" />
      <div>
        <div className="text-[13px] font-semibold text-emerald-700">
          {shop.salonboard_enabled ? '接続可能' : '認証情報あり・無効'}
        </div>
        <div className="text-[11px] text-emerald-700/80">アプリから復号済み認証情報を取得してスクレイピングできます。</div>
      </div>
    </div>
  );
}

function CredentialBadge({ shop }: { shop: SalonboardShop }) {
  if (!shop.has_credentials) {
    return <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-bold text-amber-700">未接続</span>;
  }
  if (!shop.salonboard_enabled) {
    return <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-bold text-slate-600">停止中</span>;
  }
  return <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-bold text-emerald-700">接続</span>;
}

function SyncResult({ result }: { result: SalonboardSyncResult }) {
  const keys = Object.keys(TARGET_LABELS) as Array<keyof SyncTargets>;
  return (
    <div className="rounded-[14px] border border-hairline bg-white/80 p-3">
      <div className="mb-2 flex items-center justify-between">
        <div className="text-[13px] font-bold text-ink">
          同期結果: {result.ok ? '成功' : '一部失敗'}
        </div>
        <div className="text-[10px] text-muted">{new Date(result.syncedAt).toLocaleString('ja-JP')}</div>
      </div>
      <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-4">
        {keys.map((key) => {
          const r = result.results[key];
          if (!r) return null;
          return (
            <div key={key} className="rounded-[10px] bg-brand-light/30 px-3 py-2">
              <div className="text-[11px] font-bold text-ink">{TARGET_LABELS[key]}</div>
              {r.error ? (
                <div className="mt-1 text-[10px] font-semibold text-red-700">{r.error}</div>
              ) : (
                <div className="mt-1 text-[10px] text-ink-soft">
                  取得 {r.scraped} / 追加 {r.inserted} / 更新 {r.updated}
                </div>
              )}
            </div>
          );
        })}
      </div>
      {result.logs.length > 0 && (
        <details className="mt-3">
          <summary className="cursor-pointer text-[11px] font-semibold text-brand-700">ログを表示</summary>
          <pre className="mt-2 max-h-44 overflow-auto rounded-[10px] bg-slate-950 p-3 text-[10px] leading-relaxed text-slate-100">
            {result.logs.join('\n')}
          </pre>
        </details>
      )}
    </div>
  );
}

function Field({
  label,
  value,
  actionLabel,
  danger,
  icon,
}: {
  label: string;
  value: string;
  actionLabel?: string;
  danger?: boolean;
  icon?: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between rounded-[12px] border border-hairline bg-white/85 px-3 py-2">
      <div className="flex items-center gap-2">
        {icon && (
          <span className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-brand-light text-brand-700">
            {icon}
          </span>
        )}
        <div>
          <div className="text-[10px] uppercase tracking-wider text-muted">{label}</div>
          <div className="text-[13px] font-semibold text-ink">{value}</div>
        </div>
      </div>
      {actionLabel && (
        <button
          type="button"
          className={
            danger
              ? 'rounded-[8px] border border-red-200 bg-red-50 px-3 py-1 text-[11px] font-semibold text-red-700 hover:bg-red-100'
              : 'rounded-[8px] border border-hairline bg-white px-3 py-1 text-[11px] font-semibold text-brand-700 hover:bg-brand-light/40'
          }
        >
          {actionLabel}
        </button>
      )}
    </div>
  );
}

function ToggleRow({
  icon,
  label,
  description,
  on,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  description: string;
  on?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center gap-3 rounded-[12px] border border-hairline bg-white/85 p-3 text-left hover:bg-brand-light/30"
    >
      <span className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-brand-light text-brand-700">
        {icon}
      </span>
      <span className="flex-1">
        <span className="block text-[13px] font-semibold text-ink">{label}</span>
        <span className="block text-[11px] text-ink-soft">{description}</span>
      </span>
      <span
        className={
          on
            ? 'inline-flex h-5 w-9 items-center rounded-full bg-brand p-0.5'
            : 'inline-flex h-5 w-9 items-center rounded-full bg-hairline p-0.5'
        }
      >
        <span
          className={
            on
              ? 'inline-block h-4 w-4 translate-x-4 rounded-full bg-white shadow-sm transition'
              : 'inline-block h-4 w-4 rounded-full bg-white shadow-sm transition'
          }
        />
      </span>
    </button>
  );
}

function ToggleChip({
  icon,
  label,
  on,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  on: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        on
          ? 'inline-flex h-10 items-center justify-center gap-1 rounded-[12px] bg-brand-gradient px-3 text-[12px] font-semibold text-white shadow-brand-sm'
          : 'inline-flex h-10 items-center justify-center gap-1 rounded-[12px] border border-hairline bg-white px-3 text-[12px] font-semibold text-ink-soft hover:bg-brand-light/40'
      }
    >
      {icon}
      {label}
    </button>
  );
}

function targetIcon(key: keyof SyncTargets) {
  if (key === 'bookings') return <Database className="h-3.5 w-3.5" />;
  if (key === 'staff') return <Key className="h-3.5 w-3.5" />;
  if (key === 'shifts') return <RefreshCcw className="h-3.5 w-3.5" />;
  return <FileText className="h-3.5 w-3.5" />;
}
