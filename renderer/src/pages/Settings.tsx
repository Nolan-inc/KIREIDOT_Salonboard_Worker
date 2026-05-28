import {
  ShieldCheck,
  Key,
  RefreshCcw,
  Database,
  FileText,
  LogOut,
  User,
  Download,
  CheckCircle2,
  Loader2,
  AlertCircle,
  Building2,
  Store,
  Save,
  Trash2,
  PlugZap,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { Card, CardBody, CardHeader } from '../components/Card';
import { useAuth } from '../lib/auth-context';
import { useSelection } from '../lib/selection-context';
import { supabase } from '../lib/supabase';

export function Settings() {
  const auth = useAuth();
  return (
    <div className="flex flex-col gap-5 pt-4">
      {/* アプリ情報・アップデート */}
      <UpdateSection />

      {/* 操作中の会社・店舗 */}
      <CurrentSelectionSection />

      {/* アカウント */}
      <Card>
        <CardHeader title="アカウント" subtitle="このアプリでログイン中のスタッフ情報" />
        <CardBody className="space-y-3">
          {auth.status === 'signed-in' ? (
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

      {/* SalonBoard 連携デバイス設定 (v0.2.5) */}
      <DeviceConfigSection />

      {/* 同期 */}
      <Card>
        <CardHeader title="同期" subtitle="自動同期の間隔・対象" />
        <CardBody className="space-y-3">
          <ToggleRow icon={<RefreshCcw className="h-4 w-4" />} label="自動同期" description="設定した間隔でサロンボードから取得します" on />
          <Field label="同期間隔" value="15 分ごと" actionLabel="変更" />
          <SyncTargets />
        </CardBody>
      </Card>

      {/* データ */}
      <Card>
        <CardHeader title="ローカルデータ" subtitle="このマシンに保存されている情報" />
        <CardBody className="space-y-3">
          <Field label="ログイン Cookie" value="保存中 (約 12 KB)" actionLabel="削除" danger />
          <Field label="同期ログ" value="直近 30 日分" actionLabel="エクスポート" />
        </CardBody>
      </Card>
    </div>
  );
}

/**
 * 操作中の会社・店舗の表示と、選択解除のショートカット。
 * 会社の切替は右上のチップから、店舗の切替はサイドバー「店舗一覧」から。
 */
function CurrentSelectionSection() {
  const auth = useAuth();
  const { selectedOrgId, selectedShopId, setSelectedShop, clear } = useSelection();
  const [orgName, setOrgName] = useState<string | null>(null);
  const [shopName, setShopName] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (selectedOrgId) {
        const { data } = await supabase
          .from('organizations')
          .select('name')
          .eq('id', selectedOrgId)
          .maybeSingle();
        if (!cancelled) setOrgName(((data as any)?.name ?? null) as string | null);
      } else setOrgName(null);
      if (selectedShopId) {
        const { data } = await supabase
          .from('shops')
          .select('name')
          .eq('id', selectedShopId)
          .maybeSingle();
        if (!cancelled) setShopName(((data as any)?.name ?? null) as string | null);
      } else setShopName(null);
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedOrgId, selectedShopId]);

  const role = auth.status === 'signed-in' ? auth.scope.role : null;
  const canSwitchOrg = role === 'super_owner' || role === 'admin';

  return (
    <Card>
      <CardHeader
        title="操作中の会社・店舗"
        subtitle="ダッシュボードや予約はここで選んだ会社・店舗のデータを表示します"
      />
      <CardBody className="space-y-3">
        <Field
          label="会社"
          value={orgName ?? '未選択'}
          icon={<Building2 className="h-4 w-4" />}
          actionLabel={canSwitchOrg ? '右上で切替' : undefined}
        />
        <Field
          label="店舗"
          value={shopName ?? '未選択'}
          icon={<Store className="h-4 w-4" />}
        />
        <div className="flex gap-2 pt-1">
          {selectedShopId && (
            <button
              type="button"
              onClick={() => setSelectedShop(null)}
              className="inline-flex items-center gap-1.5 rounded-[10px] border border-hairline bg-white px-3 py-1.5 text-[11px] font-semibold text-ink-soft hover:bg-brand-light/40"
            >
              店舗の選択を解除
            </button>
          )}
          {(selectedOrgId || selectedShopId) && canSwitchOrg && (
            <button
              type="button"
              onClick={() => clear()}
              className="inline-flex items-center gap-1.5 rounded-[10px] border border-hairline bg-white px-3 py-1.5 text-[11px] font-semibold text-ink-soft hover:bg-brand-light/40"
            >
              選択をすべてクリア
            </button>
          )}
        </div>
      </CardBody>
    </Card>
  );
}

/**
 * アプリのバージョン情報と「アップデート確認」セクション。
 * - 現在のバージョン表示
 * - 「今すぐ確認」ボタン → main プロセスの autoUpdater.checkForUpdates() を発火
 * - ステータスをリアルタイム表示 (checking / available / downloading / downloaded / not-available / error)
 * - downloaded 状態のときは「今すぐ再起動」ボタンを表示
 */
function UpdateSection() {
  const [status, setStatus] = useState<UpdaterStatus | null>(null);
  const [checking, setChecking] = useState(false);
  const [lastCheckedAt, setLastCheckedAt] = useState<Date | null>(null);

  useEffect(() => {
    const api = window.kireidotApp;
    if (!api) return;
    return api.onUpdaterStatus((s) => {
      setStatus(s);
      if (s.type === 'not-available' || s.type === 'available' || s.type === 'error') {
        setChecking(false);
        setLastCheckedAt(new Date());
      }
    });
  }, []);

  async function manualCheck() {
    setChecking(true);
    setStatus({ type: 'checking' });
    try {
      await window.kireidotApp?.checkForUpdate();
    } catch (e) {
      setStatus({
        type: 'error',
        message: e instanceof Error ? e.message : String(e),
      });
    } finally {
      // 結果は onUpdaterStatus 経由でも届くので、保険として 6 秒後に解除
      setTimeout(() => setChecking(false), 6000);
    }
  }

  const currentVersion = window.salondesk?.version ?? '-';
  const inElectron = !!window.kireidotApp;

  return (
    <Card>
      <CardHeader
        title="アップデート"
        subtitle="新しいバージョンを自動でダウンロード・適用します"
      />
      <CardBody className="space-y-3">
        <div className="flex items-center justify-between rounded-[12px] border border-hairline bg-white/85 px-3 py-2.5">
          <div>
            <div className="text-[10px] uppercase tracking-wider text-muted">
              現在のバージョン
            </div>
            <div className="text-[13px] font-semibold text-ink">v{currentVersion}</div>
            {lastCheckedAt && (
              <div className="text-[10px] text-ink-soft mt-0.5">
                最終確認: {lastCheckedAt.toLocaleTimeString('ja-JP')}
              </div>
            )}
          </div>
          {inElectron ? (
            <button
              type="button"
              onClick={manualCheck}
              disabled={checking}
              className="inline-flex items-center gap-1.5 rounded-[10px] border border-hairline bg-white px-3 py-1.5 text-[11px] font-semibold text-brand-700 hover:bg-brand-light/40 disabled:opacity-50"
            >
              {checking ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <RefreshCcw className="h-3.5 w-3.5" />
              )}
              {checking ? '確認中…' : '今すぐ確認'}
            </button>
          ) : (
            <span className="text-[10px] text-ink-soft">Web版では無効</span>
          )}
        </div>

        {/* ステータス表示 */}
        {status?.type === 'not-available' && (
          <div className="flex items-center gap-2 rounded-[10px] bg-emerald-50 px-3 py-2 text-[11px] text-emerald-700">
            <CheckCircle2 className="h-3.5 w-3.5" />
            最新バージョンです。
          </div>
        )}
        {status?.type === 'available' && (
          <div className="flex items-center gap-2 rounded-[10px] bg-brand-light/60 px-3 py-2 text-[11px] text-brand-700">
            <Download className="h-3.5 w-3.5" />
            v{status.version} を取得中…
          </div>
        )}
        {status?.type === 'downloading' && (
          <div className="flex items-center gap-2 rounded-[10px] bg-brand-light/60 px-3 py-2 text-[11px] text-brand-700">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ダウンロード中… {status.percent}%
          </div>
        )}
        {status?.type === 'downloaded' && (
          <div className="flex items-start gap-2 rounded-[10px] border border-brand-200 bg-brand-light/40 px-3 py-2.5">
            <Download className="mt-0.5 h-3.5 w-3.5 shrink-0 text-brand-700" />
            <div className="flex-1">
              <div className="text-[12px] font-semibold text-ink">
                v{status.version} のダウンロード完了
              </div>
              <div className="text-[10.5px] text-ink-soft mt-0.5">
                次回起動時に自動適用されます。今すぐ反映するには再起動してください。
              </div>
            </div>
            <button
              type="button"
              onClick={() => window.kireidotApp?.quitAndInstallUpdate()}
              className="shrink-0 rounded-[8px] bg-brand-gradient px-3 py-1.5 text-[11px] font-semibold text-white shadow-brand-sm"
            >
              今すぐ再起動
            </button>
          </div>
        )}
        {status?.type === 'error' && (
          <div className="flex items-start gap-2 rounded-[10px] bg-red-50 px-3 py-2 text-[11px] text-red-700">
            <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <div>
              <div className="font-semibold">確認に失敗しました</div>
              <div className="mt-0.5 text-[10.5px] text-red-600/80 break-words">
                {status.message}
              </div>
            </div>
          </div>
        )}

        <p className="text-[10px] text-ink-soft leading-relaxed">
          バックグラウンドで 6 時間ごとに自動確認も行います。配信元:
          GitHub Releases (Nolan-inc/KIREIDOT_Salonboard_Worker)。
        </p>
      </CardBody>
    </Card>
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
  icon?: React.ReactNode;
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
}: {
  icon: React.ReactNode;
  label: string;
  description: string;
  on?: boolean;
}) {
  return (
    <div className="flex items-center gap-3 rounded-[12px] border border-hairline bg-white/85 p-3">
      <span className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-brand-light text-brand-700">
        {icon}
      </span>
      <div className="flex-1">
        <div className="text-[13px] font-semibold text-ink">{label}</div>
        <div className="text-[11px] text-ink-soft">{description}</div>
      </div>
      <span
        className={
          on
            ? 'inline-flex h-5 w-9 cursor-pointer items-center rounded-full bg-brand p-0.5'
            : 'inline-flex h-5 w-9 cursor-pointer items-center rounded-full bg-hairline p-0.5'
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
    </div>
  );
}

function SyncTargets() {
  const items = [
    { key: 'bookings', label: '予約', icon: <Database className="h-3 w-3" />, on: true },
    { key: 'staff', label: 'スタッフ', icon: <Key className="h-3 w-3" />, on: true },
    { key: 'shifts', label: 'シフト', icon: <RefreshCcw className="h-3 w-3" />, on: true },
    { key: 'blog', label: 'ブログ', icon: <FileText className="h-3 w-3" />, on: false },
  ];
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-muted">同期対象</div>
      <div className="mt-1.5 flex flex-wrap gap-2">
        {items.map((it) => (
          <span
            key={it.key}
            className={
              it.on
                ? 'inline-flex items-center gap-1 rounded-full bg-brand-gradient px-2.5 py-1 text-[11px] font-semibold text-white shadow-brand-sm'
                : 'inline-flex items-center gap-1 rounded-full border border-hairline bg-white px-2.5 py-1 text-[11px] font-semibold text-ink-soft'
            }
          >
            {it.icon}
            {it.label}
          </span>
        ))}
      </div>
    </div>
  );
}

// =====================================================================
// SalonBoard 連携デバイス設定 (v0.2.5)
//
// 店舗 PC ごとに Admin (/admin/salonboard/devices) で発行した
// Device ID / Device Token を入力 → 接続テスト → userData に保存。
// token は入力欄以外には保存後 last4 のみ表示する。
// =====================================================================
const DEFAULT_API_URL = 'https://admin.kireidot.jp';

function DeviceConfigSection() {
  const [loading, setLoading] = useState(true);
  const [config, setConfig] = useState<DeviceConfigMasked | null>(null);

  // 入力フォーム
  const [apiUrl, setApiUrl] = useState(DEFAULT_API_URL);
  const [deviceId, setDeviceId] = useState('');
  const [deviceToken, setDeviceToken] = useState('');
  const [deviceName, setDeviceName] = useState('');
  const [editing, setEditing] = useState(false);

  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{
    ok: boolean;
    code: string;
    message?: string;
    shopsReady?: number;
    shopsTotal?: number;
  } | null>(null);

  const bridge = typeof window !== 'undefined' ? window.kireidotApp : undefined;

  const reload = async () => {
    if (!bridge?.deviceConfig) {
      setLoading(false);
      return;
    }
    const c = await bridge.deviceConfig.get();
    setConfig(c);
    if (c.configured) {
      setApiUrl(c.apiUrl ?? DEFAULT_API_URL);
      setDeviceId(c.deviceId ?? '');
      setDeviceName(c.deviceName ?? '');
    }
    setLoading(false);
  };

  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onTest = async () => {
    if (!bridge?.deviceConfig) return;
    setBusy(true);
    setResult(null);
    // 入力中なら入力値で、そうでなければ保存済み設定でテスト
    const payload =
      editing || !config?.configured
        ? { apiUrl: apiUrl.trim(), deviceId: deviceId.trim(), deviceToken: deviceToken.trim() }
        : undefined;
    if (payload && (!payload.apiUrl || !payload.deviceId || !payload.deviceToken)) {
      setResult({ ok: false, code: 'invalid_input', message: 'API URL / Device ID / Token を入力してください' });
      setBusy(false);
      return;
    }
    const r = await bridge.deviceConfig.test(payload);
    setResult({
      ok: r.ok,
      code: r.code,
      message: r.message,
      shopsTotal: r.shops?.length,
      shopsReady: (r.shops ?? []).filter(
        (s) =>
          s.credential_status === 'active' &&
          s.enabled &&
          s.consent_status === 'valid',
      ).length,
    });
    setBusy(false);
  };

  const onSave = async () => {
    if (!bridge?.deviceConfig) return;
    setBusy(true);
    setResult(null);
    const r = await bridge.deviceConfig.save({
      apiUrl: apiUrl.trim(),
      deviceId: deviceId.trim(),
      deviceToken: deviceToken.trim(),
      deviceName: deviceName.trim() || undefined,
    });
    setResult({
      ok: r.ok,
      code: r.code,
      message: r.message,
      shopsTotal: r.shops?.length,
      shopsReady: (r.shops ?? []).filter(
        (s) =>
          s.credential_status === 'active' &&
          s.enabled &&
          s.consent_status === 'valid',
      ).length,
    });
    setConfig(r.config ?? null);
    setEditing(false);
    setDeviceToken(''); // 保存後はフォームから token をクリア (画面に残さない)
    setBusy(false);
  };

  const onClear = async () => {
    if (!bridge?.deviceConfig) return;
    if (!confirm('このPCのデバイス設定を削除しますか？同期できなくなります。')) return;
    await bridge.deviceConfig.clear();
    setConfig({ configured: false });
    setApiUrl(DEFAULT_API_URL);
    setDeviceId('');
    setDeviceToken('');
    setDeviceName('');
    setEditing(false);
    setResult(null);
  };

  if (!bridge?.deviceConfig) {
    return (
      <Card>
        <CardHeader title="SalonBoard 連携デバイス" subtitle="この機能はデスクトップアプリでのみ利用できます" />
        <CardBody>
          <p className="text-[12px] text-ink-soft">ブラウザ版では設定できません。</p>
        </CardBody>
      </Card>
    );
  }

  const configured = config?.configured ?? false;
  const showForm = editing || !configured;

  return (
    <Card>
      <CardHeader
        title="SalonBoard 連携デバイス"
        subtitle="この店舗PCの device 設定 (管理画面で発行した Device ID / Token を登録)"
      />
      <CardBody className="space-y-4">
        {loading ? (
          <div className="flex items-center gap-2 text-[12px] text-ink-soft">
            <Loader2 className="h-4 w-4 animate-spin" /> 読み込み中…
          </div>
        ) : (
          <>
            {/* 現在の状態 */}
            {configured ? (
              <div className="flex items-start gap-3 rounded-[12px] bg-emerald-50 p-3">
                <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-emerald-600" />
                <div className="flex-1 text-[12px] text-emerald-800">
                  <div className="font-semibold">デバイス設定済み</div>
                  <div className="mt-1 space-y-0.5 text-[11px] text-emerald-700/90">
                    <div>名前: {config?.deviceName ?? '(未設定)'}</div>
                    <div>Device ID: {config?.deviceId?.slice(0, 8)}…</div>
                    <div>Token: ****{config?.tokenLast4 ?? '????'}</div>
                    <div>API: {config?.apiUrl}</div>
                    <div>
                      最終確認:{' '}
                      {config?.lastVerifiedAt
                        ? new Date(config.lastVerifiedAt).toLocaleString('ja-JP')
                        : '未検証'}
                    </div>
                  </div>
                </div>
              </div>
            ) : (
              <div className="flex items-start gap-3 rounded-[12px] bg-amber-50 p-3">
                <AlertCircle className="mt-0.5 h-5 w-5 shrink-0 text-amber-600" />
                <div className="text-[12px] text-amber-800">
                  <div className="font-semibold">デバイス未設定</div>
                  <div className="mt-0.5 text-[11px] text-amber-700/90">
                    管理画面 (/admin/salonboard/devices) で device を発行し、
                    表示された Device ID / Token をここに登録してください。
                  </div>
                </div>
              </div>
            )}

            {/* 入力フォーム */}
            {showForm ? (
              <div className="space-y-3">
                <LabeledInput
                  label="API URL"
                  value={apiUrl}
                  onChange={setApiUrl}
                  placeholder="https://admin.kireidot.jp"
                />
                <LabeledInput
                  label="Device ID"
                  value={deviceId}
                  onChange={setDeviceId}
                  placeholder="00000000-0000-0000-0000-000000000000"
                  mono
                />
                <LabeledInput
                  label="Device Token"
                  value={deviceToken}
                  onChange={setDeviceToken}
                  placeholder="発行時に1回だけ表示されたトークン"
                  password
                  mono
                />
                <LabeledInput
                  label="デバイス名 (任意)"
                  value={deviceName}
                  onChange={setDeviceName}
                  placeholder="例: 銀座本店-受付PC"
                />
              </div>
            ) : null}

            {/* 接続テスト結果 */}
            {result && (
              <div
                className={
                  result.ok
                    ? 'rounded-[10px] bg-emerald-50 px-3 py-2 text-[12px] text-emerald-800'
                    : 'rounded-[10px] bg-rose-50 px-3 py-2 text-[12px] text-rose-800'
                }
              >
                {result.ok ? (
                  <span className="inline-flex items-center gap-1">
                    <CheckCircle2 className="h-3.5 w-3.5" /> 接続成功
                    {typeof result.shopsReady === 'number' &&
                      ` (${result.shopsReady}/${result.shopsTotal} 店舗が同期可能)`}
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1">
                    <AlertCircle className="h-3.5 w-3.5" />
                    {result.message ?? `失敗 (${result.code})`}
                  </span>
                )}
              </div>
            )}

            {/* ボタン群 */}
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={onTest}
                disabled={busy}
                className="inline-flex items-center gap-1.5 rounded-[10px] border border-hairline bg-white px-3 py-2 text-[12px] font-semibold text-ink hover:bg-surface-soft disabled:opacity-50"
              >
                {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <PlugZap className="h-3.5 w-3.5" />}
                接続テスト
              </button>

              {showForm ? (
                <button
                  type="button"
                  onClick={onSave}
                  disabled={busy}
                  className="inline-flex items-center gap-1.5 rounded-[10px] bg-brand-gradient px-3 py-2 text-[12px] font-semibold text-white shadow-brand-sm disabled:opacity-50"
                >
                  <Save className="h-3.5 w-3.5" /> 保存
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => {
                    setEditing(true);
                    setDeviceToken('');
                  }}
                  className="inline-flex items-center gap-1.5 rounded-[10px] border border-hairline bg-white px-3 py-2 text-[12px] font-semibold text-ink hover:bg-surface-soft"
                >
                  <Key className="h-3.5 w-3.5" /> 設定を変更
                </button>
              )}

              {configured && (
                <button
                  type="button"
                  onClick={onClear}
                  disabled={busy}
                  className="ml-auto inline-flex items-center gap-1.5 rounded-[10px] border border-rose-200 bg-rose-50 px-3 py-2 text-[12px] font-semibold text-rose-700 hover:bg-rose-100 disabled:opacity-50"
                >
                  <Trash2 className="h-3.5 w-3.5" /> 設定を削除
                </button>
              )}
            </div>

            <p className="text-[11px] text-ink-soft">
              ※ Device Token はこの PC 内 (userData) にのみ保存され、画面には末尾4桁しか表示されません。
              紛失・漏洩時は管理画面で「token再発行」してください。
            </p>
          </>
        )}
      </CardBody>
    </Card>
  );
}

function LabeledInput({
  label,
  value,
  onChange,
  placeholder,
  password,
  mono,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  password?: boolean;
  mono?: boolean;
}) {
  return (
    <label className="block">
      <span className="text-[11px] font-semibold text-ink-soft">{label}</span>
      <input
        type={password ? 'password' : 'text'}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        spellCheck={false}
        autoComplete="off"
        className={`mt-1 w-full rounded-[10px] border border-hairline bg-white px-3 py-2 text-[12px] text-ink placeholder:text-muted-faint focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/20 ${
          mono ? 'font-mono' : ''
        }`}
      />
    </label>
  );
}
