import { useEffect, useState } from 'react';
import { Download, Loader2, RefreshCw, X } from 'lucide-react';

/**
 * 自動アップデートのステータスをユーザーに通知する右下トースト。
 *
 * 流れ:
 *   起動直後  → 'checking' (UIには出さない)
 *   見つかった → 'available' → 'downloading' (進捗のみ静かに表示)
 *   完了      → 'downloaded' (バナー表示「次回起動時に更新されます / 今すぐ再起動」)
 *
 * Electron 以外 (window.kireidotApp 不在) では無効。
 */
export function UpdaterToast() {
  const [status, setStatus] = useState<UpdaterStatus | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    const api = window.kireidotApp;
    if (!api) return;
    return api.onUpdaterStatus((s) => {
      setStatus(s);
      // 新たな進行があればユーザーの dismiss はリセット
      if (s.type === 'downloaded' || s.type === 'error') setDismissed(false);
    });
  }, []);

  if (!status || dismissed) return null;
  if (status.type === 'checking' || status.type === 'not-available') return null;

  // ダウンロード中の小さなバッジ (邪魔しない位置)
  if (status.type === 'available' || status.type === 'downloading') {
    const percent = status.type === 'downloading' ? status.percent : 0;
    return (
      <div className="pointer-events-none fixed bottom-4 right-4 z-50 select-none">
        <div className="pointer-events-auto flex items-center gap-2 rounded-full border border-hairline bg-white/95 px-3 py-1.5 text-[11px] text-ink-soft shadow-sm backdrop-blur">
          <Loader2 className="h-3 w-3 animate-spin text-brand-500" />
          <span>アップデート取得中… {percent ? `${percent}%` : ''}</span>
        </div>
      </div>
    );
  }

  // エラー時 (静かに 1 行で)
  if (status.type === 'error') {
    return (
      <div className="fixed bottom-4 right-4 z-50 w-80 max-w-[92vw] select-none">
        <div className="flex items-start gap-3 rounded-[12px] border border-red-200 bg-white/95 px-4 py-3 shadow-card backdrop-blur">
          <div className="flex-1">
            <div className="text-[12px] font-semibold text-red-700">
              アップデート確認に失敗しました
            </div>
            <div className="mt-0.5 break-words text-[10.5px] text-red-600/80">
              {status.message}
            </div>
          </div>
          <button
            type="button"
            onClick={() => setDismissed(true)}
            className="-mr-1 -mt-1 rounded p-1 text-muted hover:bg-slate-100"
            aria-label="閉じる"
          >
            <X size={14} />
          </button>
        </div>
      </div>
    );
  }

  // status.type === 'downloaded'
  return (
    <div className="fixed bottom-4 right-4 z-50 w-80 max-w-[92vw] select-none">
      <div className="flex flex-col gap-2 rounded-[14px] border border-brand-200 bg-white/95 px-4 py-3 shadow-card backdrop-blur">
        <div className="flex items-start gap-2.5">
          <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-brand-light text-brand-700">
            <Download size={14} />
          </div>
          <div className="flex-1">
            <div className="text-[12.5px] font-semibold text-ink">
              新しいバージョンが利用可能です
            </div>
            <div className="mt-0.5 text-[10.5px] text-ink-soft">
              v{status.version} が次回起動時に自動で適用されます。
            </div>
          </div>
          <button
            type="button"
            onClick={() => setDismissed(true)}
            className="-mr-1 -mt-1 rounded p-1 text-muted hover:bg-slate-100"
            aria-label="閉じる"
          >
            <X size={14} />
          </button>
        </div>
        <button
          type="button"
          onClick={async () => {
            await window.kireidotApp?.quitAndInstallUpdate();
          }}
          className="inline-flex h-8 items-center justify-center gap-1.5 rounded-[10px] bg-brand-gradient text-[12px] font-semibold text-white shadow-brand-sm transition hover:shadow-brand"
        >
          <RefreshCw size={12} />
          今すぐ再起動して更新
        </button>
      </div>
    </div>
  );
}
