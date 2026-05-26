import { AlertTriangle, RefreshCw, X } from 'lucide-react';
import { useState } from 'react';
import { useSyncController } from '../lib/sync-controller';

/**
 * 店舗PC の device 設定が不完全 / 何か問題があるときに画面上部に出すバナー。
 * sync-controller の setupStatus を見て、code !== 'ok' のときだけ表示する。
 *
 * ok / unknown のときは何も描画しない (= 静か)。
 */
export function SetupStatusBanner() {
  const { setupStatus, refreshSetupStatus } = useSyncController();
  const [dismissed, setDismissed] = useState(false);

  if (dismissed) return null;
  if (setupStatus.code === 'ok' || setupStatus.code === 'unknown') return null;

  const tone = bannerTone(setupStatus.code);
  return (
    <div
      className={`app-no-drag flex items-start gap-3 border-b px-6 py-3 text-sm ${tone.bg} ${tone.text} ${tone.border}`}
      role="status"
      aria-live="polite"
    >
      <AlertTriangle className={`mt-0.5 h-4 w-4 shrink-0 ${tone.icon}`} />
      <div className="flex-1 leading-snug">
        <p className="font-medium">{titleFor(setupStatus.code)}</p>
        <p className="opacity-90">{setupStatus.message}</p>
        {setupStatus.detail && (
          <p className="mt-1 text-[11px] opacity-70">
            {typeof setupStatus.detail.shopsTotal === 'number'
              ? `店舗: ${setupStatus.detail.shopsReady ?? 0}/${setupStatus.detail.shopsTotal} 同期可能`
              : ''}
            {typeof setupStatus.detail.blockedShops === 'number' &&
            setupStatus.detail.blockedShops > 0
              ? ` · ${setupStatus.detail.blockedShops}店舗ブロック中`
              : ''}
            {setupStatus.detail.deviceStatus
              ? ` · device: ${setupStatus.detail.deviceStatus}`
              : ''}
          </p>
        )}
      </div>
      <button
        type="button"
        onClick={() => {
          void refreshSetupStatus();
        }}
        className="inline-flex items-center gap-1 rounded-md border border-current/30 px-2 py-1 text-xs hover:bg-white/30"
        title="設定状態を再確認"
      >
        <RefreshCw className="h-3 w-3" /> 再確認
      </button>
      <button
        type="button"
        onClick={() => setDismissed(true)}
        className="rounded-md p-1 hover:bg-white/30"
        title="閉じる"
      >
        <X className="h-3 w-3" />
      </button>
    </div>
  );
}

function titleFor(code: string): string {
  switch (code) {
    case 'device_unconfigured':
      return 'デバイス設定が未完了';
    case 'device_unauthorized':
      return 'デバイス認証に失敗';
    case 'no_shops_assigned':
      return '担当店舗が未割当';
    case 'all_shops_blocked':
      return '全店舗が一時ブロック中';
    case 'missing_consent':
      return 'SalonBoard連携の同意未取得';
    case 'missing_credentials':
      return 'SalonBoard認証情報が未設定';
    case 'network_error':
      return 'KIREIDOT Admin と通信できません';
    default:
      return '注意';
  }
}

function bannerTone(code: string): {
  bg: string;
  text: string;
  border: string;
  icon: string;
} {
  switch (code) {
    case 'device_unconfigured':
    case 'no_shops_assigned':
    case 'missing_credentials':
    case 'missing_consent':
      return {
        bg: 'bg-amber-50',
        text: 'text-amber-900',
        border: 'border-amber-200',
        icon: 'text-amber-600',
      };
    case 'device_unauthorized':
    case 'all_shops_blocked':
    case 'network_error':
      return {
        bg: 'bg-rose-50',
        text: 'text-rose-900',
        border: 'border-rose-200',
        icon: 'text-rose-600',
      };
    default:
      return {
        bg: 'bg-gray-50',
        text: 'text-gray-800',
        border: 'border-gray-200',
        icon: 'text-gray-500',
      };
  }
}
