import { useEffect, useState } from 'react';
import { Loader2, RefreshCcw, Scissors, ImageOff } from 'lucide-react';
import { Card } from '../components/Card';
import { useEffectiveScope } from '../lib/selection-context';
import { fetchStyleList, type StyleRow } from '../lib/data';
import { useSyncController } from '../lib/sync-controller';

/**
 * 美容室「スタイル」一覧ページ。
 * SalonBoard のスタイル掲載情報 (styleList) を取得し、salonboard_style_imports に
 * 画像付きで保存したものを Instagram 風グリッドで表示する (読み取り専用・最大100件)。
 *
 * 取得は menus チャネルの同期で行われる (美容室はメニュー=スタイルが同じ styleList 由来)。
 */
export function Styles() {
  const scope = useEffectiveScope();
  const sync = useSyncController();
  const [loading, setLoading] = useState(true);
  const [styles, setStyles] = useState<StyleRow[]>([]);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    if (!scope) return;
    let cancelled = false;
    setLoading(true);
    fetchStyleList(scope)
      .then((data) => !cancelled && setStyles(data))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [scope?.shopId, scope?.organizationId, reloadKey]);

  const canSync = !!scope?.shopId && sync.ready && !sync.isRunning;

  async function syncStyles() {
    if (!scope?.shopId) return;
    // スタイルは menus チャネルで取得される (美容室の styleList)。
    await sync.syncShops([scope.shopId], ['menus']);
    // 同期完了後に少し待って再取得。
    setTimeout(() => setReloadKey((k) => k + 1), 1500);
  }

  return (
    <div className="flex flex-col gap-5 pt-4">
      <div className="flex flex-col items-stretch gap-3 lg:flex-row lg:items-center lg:justify-between">
        <p className="text-[13px] text-ink-soft">
          {loading
            ? '読み込み中…'
            : `SalonBoard から取得したスタイル ${styles.length} 件 (最大100件)`}
        </p>
        <button
          type="button"
          onClick={syncStyles}
          disabled={!canSync}
          title={scope?.shopId ? 'SalonBoard からスタイルを取得' : '先に店舗を選択してください'}
          className="inline-flex h-9 items-center gap-1.5 rounded-[12px] border border-hairline bg-white/80 px-4 text-[12px] font-semibold text-ink-soft hover:bg-brand-light/40 disabled:opacity-50"
        >
          {sync.isRunning ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <RefreshCcw className="h-3.5 w-3.5" />
          )}
          サロンボードから取得
        </button>
      </div>

      <Card className="overflow-hidden">
        {loading ? (
          <div className="flex items-center gap-2 px-5 py-10 text-[13px] text-ink-soft">
            <Loader2 className="h-4 w-4 animate-spin" /> 読み込み中…
          </div>
        ) : styles.length === 0 ? (
          <div className="px-5 py-12 text-center text-[13px] text-ink-soft">
            <Scissors className="mx-auto mb-2 h-6 w-6 text-muted-faint" />
            スタイルがありません。
            <br />
            「サロンボードから取得」を押すと SalonBoard のスタイル一覧 (最大100件) を取り込めます。
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-3 p-4 sm:grid-cols-3 lg:grid-cols-5">
            {styles.map((s) => (
              <div
                key={s.id}
                className="overflow-hidden rounded-[12px] border border-hairline bg-white"
              >
                <div className="relative aspect-[3/4] w-full bg-surface-soft">
                  {s.image_url ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={s.image_url}
                      alt={s.name ?? 'style'}
                      loading="lazy"
                      className="h-full w-full object-cover"
                    />
                  ) : (
                    <div className="flex h-full items-center justify-center text-muted-faint">
                      <ImageOff className="h-6 w-6" />
                    </div>
                  )}
                </div>
                <div className="space-y-0.5 p-2">
                  <div className="line-clamp-1 text-[12px] font-medium text-ink">
                    {s.name || '(無題スタイル)'}
                  </div>
                  <div className="flex flex-col gap-0.5 text-[10px] text-muted">
                    {s.stylist_name && <span className="line-clamp-1">{s.stylist_name}</span>}
                    {s.length && <span>{s.length}</span>}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
