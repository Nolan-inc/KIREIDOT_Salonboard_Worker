import { useEffect, useState } from 'react';
import { Loader2, RefreshCcw, Scissors, Image as ImageIcon, ImageOff } from 'lucide-react';
import { Card } from '../components/Card';
import { useEffectiveScope } from '../lib/selection-context';
import {
  fetchStyleList,
  fetchPhotoGalleryList,
  fetchShopGenre,
  type StyleRow,
  type PhotoGalleryRow,
} from '../lib/data';
import { useSyncController } from '../lib/sync-controller';

type GalleryItem = {
  id: string;
  title: string | null;
  sub1: string | null; // 担当 / キャプション
  sub2: string | null; // レングス / 掲載状態
  image_url: string | null;
};

/**
 * 美容室=「スタイル」/ エステ等=「フォトギャラリー」一覧ページ。
 * SalonBoard から取得して *_imports に保存した画像付きデータを Instagram 風グリッドで
 * 表示する (読み取り専用・最大100件)。取得は menus チャネルの同期で行われる。
 */
export function Styles() {
  const scope = useEffectiveScope();
  const sync = useSyncController();
  const [loading, setLoading] = useState(true);
  const [genre, setGenre] = useState<string | null>(null);
  const [items, setItems] = useState<GalleryItem[]>([]);
  const [reloadKey, setReloadKey] = useState(0);

  const isHair = genre === 'hair';
  const label = isHair ? 'スタイル' : 'フォトギャラリー';

  useEffect(() => {
    if (!scope) return;
    let cancelled = false;
    setLoading(true);
    (async () => {
      const g = await fetchShopGenre(scope);
      if (cancelled) return;
      setGenre(g);
      if (g === 'hair') {
        const rows: StyleRow[] = await fetchStyleList(scope);
        if (cancelled) return;
        setItems(
          rows.map((s) => ({
            id: s.id,
            title: s.name,
            sub1: s.stylist_name,
            sub2: s.length,
            image_url: s.image_url,
          })),
        );
      } else {
        const rows: PhotoGalleryRow[] = await fetchPhotoGalleryList(scope);
        if (cancelled) return;
        setItems(
          rows.map((p) => ({
            id: p.id,
            title: p.title,
            sub1: p.caption,
            sub2: p.is_published ? null : '非掲載',
            image_url: p.image_url,
          })),
        );
      }
    })().finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [scope?.shopId, scope?.organizationId, reloadKey]);

  const canSync = !!scope?.shopId && sync.ready && !sync.isRunning;

  async function syncItems() {
    if (!scope?.shopId) return;
    // スタイル/フォトギャラリーは menus チャネルで取得される。
    await sync.syncShops([scope.shopId], ['menus']);
    setTimeout(() => setReloadKey((k) => k + 1), 1500);
  }

  return (
    <div className="flex flex-col gap-5 pt-4">
      <div className="flex flex-col items-stretch gap-3 lg:flex-row lg:items-center lg:justify-between">
        <p className="text-[13px] text-ink-soft">
          {loading
            ? '読み込み中…'
            : `SalonBoard から取得した${label} ${items.length} 件 (最大100件)`}
        </p>
        <button
          type="button"
          onClick={syncItems}
          disabled={!canSync}
          title={scope?.shopId ? `SalonBoard から${label}を取得` : '先に店舗を選択してください'}
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
        ) : items.length === 0 ? (
          <div className="px-5 py-12 text-center text-[13px] text-ink-soft">
            {isHair ? (
              <Scissors className="mx-auto mb-2 h-6 w-6 text-muted-faint" />
            ) : (
              <ImageIcon className="mx-auto mb-2 h-6 w-6 text-muted-faint" />
            )}
            {label}がありません。
            <br />
            「サロンボードから取得」を押すと SalonBoard の{label} (最大100件) を取り込めます。
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-3 p-4 sm:grid-cols-3 lg:grid-cols-5">
            {items.map((it) => (
              <div
                key={it.id}
                className="overflow-hidden rounded-[12px] border border-hairline bg-white"
              >
                <div className="relative aspect-[3/4] w-full bg-surface-soft">
                  {it.image_url ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={it.image_url}
                      alt={it.title ?? label}
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
                    {it.title || `(無題${label})`}
                  </div>
                  <div className="flex flex-col gap-0.5 text-[10px] text-muted">
                    {it.sub1 && <span className="line-clamp-1">{it.sub1}</span>}
                    {it.sub2 && <span>{it.sub2}</span>}
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
