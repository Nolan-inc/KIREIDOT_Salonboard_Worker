import { useEffect, useState } from 'react';
import { Loader2, RefreshCcw, Scissors, Image as ImageIcon, ImageOff, FlaskConical, CheckCircle2, AlertTriangle } from 'lucide-react';
import { Card } from '../components/Card';
import { useEffectiveScope } from '../lib/selection-context';
import {
  fetchStyleList,
  fetchPhotoGalleryList,
  fetchShopGenre,
  fetchStaffList,
  type StyleRow,
  type PhotoGalleryRow,
  type StaffRow,
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

      {/* スタイル画像アップロードのテスト投稿パネル (美容室のみ) */}
      {isHair && <StyleTestPanel />}

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

// =====================================================================
// スタイル画像アップロードのテスト投稿パネル
// 画像URLとスタイリストを選んで「テスト投稿」を押すと、worker が実Chrome優先で
// styleEdit を開き、画像アップロード(〜任意で登録)まで実行。各ステップを表示する。
// =====================================================================
type TestLine = { at: string; text: string; kind: 'info' | 'ok' | 'error' };

function StyleTestPanel() {
  const scope = useEffectiveScope();
  const [stylists, setStylists] = useState<StaffRow[]>([]);
  const [imageUrl, setImageUrl] = useState('');
  const [stylistExt, setStylistExt] = useState('');
  const [enablePost, setEnablePost] = useState(false);
  const [running, setRunning] = useState(false);
  const [lines, setLines] = useState<TestLine[]>([]);

  const bridge = typeof window !== 'undefined' ? window.kireidotApp : undefined;

  useEffect(() => {
    if (!scope?.shopId) return;
    let cancelled = false;
    fetchStaffList(scope).then((rows) => {
      if (cancelled) return;
      // SalonBoard スタイリスト(T...)のみ
      const t = rows.filter((s) => (s.external_id || '').toUpperCase().startsWith('T'));
      setStylists(t);
      if (t[0]?.external_id) setStylistExt(t[0].external_id);
      // 取得済みスタイルの先頭画像をデフォルト画像にする(あれば)
      if (!imageUrl) {
        fetchStyleList(scope).then((styles) => {
          const first = styles.find((x) => x.image_url)?.image_url;
          if (first && !cancelled) setImageUrl(first);
        });
      }
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope?.shopId]);

  useEffect(() => {
    if (!bridge?.onWorkerEvent) return;
    return bridge.onWorkerEvent((msg) => {
      if (msg.type !== 'style:test') return;
      const p = msg.payload;
      const now = new Date().toLocaleTimeString('ja-JP');
      if (p.step === 'done') {
        setRunning(false);
        setLines((c) => [...c, { at: now, text: p.ok ? (p.msg || '✅ 完了') : (p.error || `失敗 (${p.errorCode || 'unknown'})`), kind: p.ok ? 'ok' : 'error' }]);
      } else {
        setLines((c) => [...c, { at: now, text: p.msg || p.step, kind: 'info' }]);
      }
    });
  }, [bridge]);

  const canRun = !!scope?.shopId && !!imageUrl.trim() && !running;

  const run = async () => {
    if (!scope?.shopId || !bridge?.workerTestStyleImage) return;
    setLines([]);
    setRunning(true);
    await bridge.workerTestStyleImage({
      shopId: scope.shopId,
      imageUrl: imageUrl.trim(),
      stylistExternalId: stylistExt || null,
      enablePost,
    });
    setTimeout(() => setRunning(false), 120_000); // 安全網
  };

  if (!bridge?.workerTestStyleImage) return null; // ブラウザ版では非表示

  const ic = 'h-10 w-full rounded-[10px] border border-hairline bg-white px-3 text-[13px] focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/20';

  return (
    <Card className="border-amber-200">
      <div className="border-b border-hairline/70 bg-amber-50/60 px-5 py-3">
        <div className="flex items-center gap-2 text-[14px] font-bold text-ink">
          <FlaskConical className="h-4 w-4 text-amber-600" /> スタイル画像アップロード テスト
        </div>
        <p className="mt-0.5 text-[11px] text-ink-soft">
          画像URLとスタイリストを選んで「テスト投稿」を押すと、実ブラウザを表示して
          styleEdit を開き、画像アップロード（任意で登録）まで実行します。
        </p>
      </div>
      <div className="px-5 py-4">
        {!scope?.shopId ? (
          <p className="text-[12px] text-ink-soft">先に店舗を選択してください。</p>
        ) : (
          <div className="flex flex-col gap-3">
            <label className="flex flex-col gap-1">
              <span className="text-[10px] uppercase tracking-wide text-muted">画像URL (公開URL)</span>
              <input type="text" value={imageUrl} onChange={(e) => setImageUrl(e.target.value)} placeholder="https://…/image.jpg" className={ic} />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-[10px] uppercase tracking-wide text-muted">担当スタイリスト</span>
              {stylists.length === 0 ? (
                <span className="text-[11px] text-amber-700">SalonBoard スタイリスト(T…)が未取得。先にスタイリストを同期してください。</span>
              ) : (
                <select value={stylistExt} onChange={(e) => setStylistExt(e.target.value)} className={ic}>
                  {stylists.map((s) => (
                    <option key={s.id} value={s.external_id ?? ''}>{s.full_name}（{s.external_id}）</option>
                  ))}
                </select>
              )}
            </label>
            <label className="flex items-center gap-2 text-[12px]">
              <input type="checkbox" checked={enablePost} onChange={(e) => setEnablePost(e.target.checked)} className="h-4 w-4 accent-brand" />
              <span className={enablePost ? 'font-semibold text-amber-700' : 'text-ink-soft'}>
                実登録する (ON: スタイル登録まで実行 / OFF: 画像アップロードのみ・登録しない)
              </span>
            </label>
            <div>
              <button
                type="button"
                onClick={run}
                disabled={!canRun}
                className="inline-flex h-10 items-center gap-1.5 rounded-[12px] bg-brand-gradient px-5 text-[13px] font-semibold text-white shadow-brand-sm disabled:opacity-50"
              >
                {running ? <Loader2 className="h-4 w-4 animate-spin" /> : <FlaskConical className="h-4 w-4" />}
                {running ? 'テスト実行中… (ブラウザが開きます)' : 'テスト投稿'}
              </button>
            </div>

            {lines.length > 0 && (
              <div className="mt-1 rounded-[10px] border border-hairline bg-surface-soft/60 p-3">
                <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted">実行ログ</div>
                <div className="flex flex-col gap-0.5 font-mono text-[11px]">
                  {lines.map((l, i) => (
                    <div key={i} className={l.kind === 'ok' ? 'text-emerald-700' : l.kind === 'error' ? 'text-red-600' : 'text-ink-soft'}>
                      <span className="text-muted-faint">{l.at}</span>{' '}
                      {l.kind === 'error' && <AlertTriangle className="mr-0.5 inline h-3 w-3" />}
                      {l.kind === 'ok' && <CheckCircle2 className="mr-0.5 inline h-3 w-3" />}
                      {l.text}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </Card>
  );
}
