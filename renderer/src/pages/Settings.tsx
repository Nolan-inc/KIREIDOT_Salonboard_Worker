import { ShieldCheck, Key, RefreshCcw, Database, FileText, LogOut, User } from 'lucide-react';
import { Card, CardBody, CardHeader } from '../components/Card';
import { useAuth } from '../lib/auth-context';

export function Settings() {
  const auth = useAuth();
  return (
    <div className="flex flex-col gap-5 pt-4">
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
