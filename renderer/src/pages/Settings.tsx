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

      {/* サロンボード連携 */}
      <Card>
        <CardHeader title="サロンボード連携" subtitle="このアプリで使うサロンボードアカウント" />
        <CardBody className="space-y-4">
          <div className="flex items-center gap-3 rounded-[12px] bg-amber-50 p-3">
            <ShieldCheck className="h-5 w-5 text-amber-600" />
            <div>
              <div className="text-[13px] font-semibold text-amber-700">未接続</div>
              <div className="text-[11px] text-amber-700/80">
                次の Phase でサロンボードの認証情報入力 UI を実装します
              </div>
            </div>
            <button
              type="button"
              className="ml-auto rounded-[10px] border border-amber-200 bg-white px-3 py-1.5 text-[11px] font-semibold text-amber-700 hover:bg-amber-50"
            >
              ログインする
            </button>
          </div>

          <Field label="サロンボード ログイン ID" value="未設定" />
          <Field label="API キー (KIREIDOT クラウドへの送信)" value="未発行" actionLabel="発行" />
        </CardBody>
      </Card>

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
