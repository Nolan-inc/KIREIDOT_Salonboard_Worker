import { useEffect, useRef, useState } from 'react';
import { Loader2, RefreshCcw, Scissors, Image as ImageIcon, ImageOff, FlaskConical, CheckCircle2, AlertTriangle, Chrome } from 'lucide-react';
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

      {/* Chrome拡張連携: 普段使いChromeでスタイルFRONT画像を自動アップロード (美容室のみ) */}
      {isHair && <StyleExtensionPanel />}

      {/* 画像アップロードのテスト投稿パネル (美容室=スタイル / エステ等=フォトギャラリー) */}
      {genre && <StyleTestPanel isHair={isHair} />}

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

function StyleTestPanel({ isHair }: { isHair: boolean }) {
  const scope = useEffectiveScope();
  const [stylists, setStylists] = useState<StaffRow[]>([]);
  const [imageUrl, setImageUrl] = useState('');
  const [stylistExt, setStylistExt] = useState('');
  const [enablePost, setEnablePost] = useState(false);
  const [running, setRunning] = useState(false);
  const [lines, setLines] = useState<TestLine[]>([]);

  const target = isHair ? 'スタイル' : 'フォトギャラリー';
  const formName = isHair ? 'styleEdit' : 'photoGalleryEdit';
  const bridge = typeof window !== 'undefined' ? window.kireidotApp : undefined;

  useEffect(() => {
    if (!scope?.shopId) return;
    let cancelled = false;
    // 美容室のみスタイリスト(T...)が必須。エステは任意。
    if (isHair) {
      fetchStaffList(scope).then((rows) => {
        if (cancelled) return;
        const t = rows.filter((s) => (s.external_id || '').toUpperCase().startsWith('T'));
        setStylists(t);
        if (t[0]?.external_id) setStylistExt(t[0].external_id);
      });
    }
    // デフォルト画像: 美容室=取得済みスタイル / エステ=取得済みフォトギャラリーの先頭画像。
    if (!imageUrl) {
      const loader = isHair ? fetchStyleList(scope) : fetchPhotoGalleryList(scope);
      loader.then((rows: Array<{ image_url: string | null }>) => {
        const first = rows.find((x) => x.image_url)?.image_url;
        if (first && !cancelled) setImageUrl(first);
      });
    }
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope?.shopId, isHair]);

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
      kind: isHair ? 'style' : 'photo_gallery',
      stylistExternalId: isHair ? (stylistExt || null) : null,
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
          <FlaskConical className="h-4 w-4 text-amber-600" /> {target}画像アップロード テスト
        </div>
        <p className="mt-0.5 text-[11px] text-ink-soft">
          画像URL{isHair ? 'とスタイリスト' : ''}を選んで「テスト投稿」を押すと、実ブラウザを表示して
          {formName} を開き、画像アップロード（任意で登録）まで実行します。
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
            {isHair && (
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
            )}
            <label className="flex items-center gap-2 text-[12px]">
              <input type="checkbox" checked={enablePost} onChange={(e) => setEnablePost(e.target.checked)} className="h-4 w-4 accent-brand" />
              <span className={enablePost ? 'font-semibold text-amber-700' : 'text-ink-soft'}>
                実登録する (ON: {target}登録まで実行 / OFF: 画像アップロードのみ・登録しない)
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

// =====================================================================
// Chrome拡張連携パネル (美容室スタイル FRONT 画像)
// 「スタイル投稿(Chrome拡張)」ボタン → ローカルブリッジにジョブ作成 →
// 普段使いChromeで styleEdit を開く → 拡張が検知して FRONT 画像を自動アップロード。
// 状態は extension:event でリアルタイム表示。
// =====================================================================
type ExtState =
  | 'idle'
  | 'creating'
  | 'chrome_opened'
  | 'picked'
  | 'uploading'
  | 'done'
  | 'failed';

const STATE_LABEL: Record<ExtState, string> = {
  idle: '待機中',
  creating: 'ジョブ作成中…',
  chrome_opened: 'Chromeでスタイル画面を開いています（拡張の検知待ち）',
  picked: '拡張がジョブを受け取りました',
  uploading: '画像アップロード中…',
  done: '✅ FRONT_IMG_ID 反映成功',
  failed: '🔴 失敗',
};

function StyleExtensionPanel() {
  const scope = useEffectiveScope();
  const [imageUrl, setImageUrl] = useState('');
  const [salonboardUrl, setSalonboardUrl] = useState('https://salonboard.com/CNB/draft/styleEdit/');
  const [state, setState] = useState<ExtState>('idle');
  const [lines, setLines] = useState<TestLine[]>([]);
  const [jobId, setJobId] = useState<string | null>(null);
  const [bridgeOk, setBridgeOk] = useState<boolean | null>(null);
  const jobIdRef = useRef<string | null>(null);

  const bridge = typeof window !== 'undefined' ? window.kireidotApp : undefined;

  const log = (text: string, kind: TestLine['kind'] = 'info') =>
    setLines((c) => [...c, { at: new Date().toLocaleTimeString('ja-JP'), text, kind }]);

  // ローカルブリッジの稼働確認。
  useEffect(() => {
    if (!bridge?.extensionBridgeHealth) return;
    bridge.extensionBridgeHealth().then((r) => setBridgeOk(!!r?.ok)).catch(() => setBridgeOk(false));
  }, [bridge]);

  // デフォルト画像: 取得済みスタイルの先頭画像。
  useEffect(() => {
    if (!scope?.shopId || imageUrl) return;
    let cancelled = false;
    fetchStyleList(scope).then((rows) => {
      const first = rows.find((x) => x.image_url)?.image_url;
      if (first && !cancelled) setImageUrl(first);
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope?.shopId]);

  // 拡張イベント購読。
  useEffect(() => {
    if (!bridge?.onExtensionEvent) return;
    return bridge.onExtensionEvent((ev) => {
      // 自分のジョブのイベントだけ反映 (jobId 一致、または job無しのbridgeイベント)。
      if (ev.jobId && jobIdRef.current && ev.jobId !== jobIdRef.current) return;
      const t = ev.type;
      if (t === 'chrome_opened') { setState('chrome_opened'); log('🌐 Chromeでスタイル画面を開きました'); }
      else if (t === 'chrome_open_failed') { setState('failed'); log('Chromeを開けませんでした: ' + (ev.error || ''), 'error'); }
      else if (t === 'job_picked') { setState('picked'); log('🤝 拡張がジョブを受け取りました'); }
      else if (t === 'job_uploading') { setState('uploading'); log('⬆️ 画像アップロード中…'); }
      else if (t === 'job_retry') { setState('chrome_opened'); log('↪️ スタイル登録画面へ移動中…自動で再実行します'); }
      else if (t === 'job_completed') { setState('done'); log('✅ FRONT_IMG_ID 反映成功 (画像ID=' + (ev.imageId || '?') + ')', 'ok'); }
      else if (t === 'job_failed') {
        setState('failed');
        const msg = String(ev.error || '');
        log('🔴 失敗: ' + msg, 'error');
        if (ev.sbError) log('SalonBoardエラー: ' + ev.sbError, 'error');
        if (/ログイン|認証/.test(msg)) {
          log('💡 普段使いの Chrome で SalonBoard にログインしてから、もう一度実行してください。', 'error');
        }
      }
      else if (t === 'bridge_error') { log('ブリッジエラー: ' + (ev.error || ''), 'error'); }
    });
  }, [bridge]);

  // 拡張の検知待ちタイムアウト(60秒で「未インストールかも」案内)。
  useEffect(() => {
    if (state !== 'chrome_opened') return;
    const id = setTimeout(() => {
      setState((s) => {
        if (s === 'chrome_opened') {
          log('⚠️ 60秒たっても拡張がジョブを取りに来ません。Chrome拡張が未インストール/未読込の可能性があります。', 'error');
          log('→ 普段使いChromeに「KireiDot SalonBoard Helper」拡張が入っているか確認してください。', 'error');
        }
        return s;
      });
    }, 60000);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  const canRun = !!imageUrl.trim() && state !== 'creating' && state !== 'uploading' && state !== 'picked';

  const run = async () => {
    if (!bridge?.extensionCreateStyleJob) return;
    setLines([]);
    setState('creating');
    log('ジョブ作成中…');
    const r = await bridge.extensionCreateStyleJob({
      imageUrl: imageUrl.trim(),
      salonboardUrl: salonboardUrl.trim(),
      shopId: scope?.shopId || null,
      shopName: scope?.shopName || null,
    });
    if (!r?.ok) {
      setState('failed');
      log('ジョブ作成に失敗: ' + (r?.error || 'unknown'), 'error');
      return;
    }
    jobIdRef.current = r.jobId || null;
    setJobId(r.jobId || null);
    log('🆕 ジョブ作成: ' + (r.jobId || '?'));
    log('普段使いChromeでスタイル画面を開きます…');
  };

  if (!bridge?.extensionCreateStyleJob) return null; // ブラウザ版では非表示

  const ic = 'h-10 w-full rounded-[10px] border border-hairline bg-white px-3 text-[13px] focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/20';
  const busy = state === 'creating' || state === 'chrome_opened' || state === 'picked' || state === 'uploading';

  return (
    <Card className="border-sky-200">
      <div className="border-b border-hairline/70 bg-sky-50/60 px-5 py-3">
        <div className="flex items-center gap-2 text-[14px] font-bold text-ink">
          <Chrome className="h-4 w-4 text-sky-600" /> スタイル投稿（Chrome拡張・自動アップロード）
        </div>
        <p className="mt-0.5 text-[11px] text-ink-soft">
          「スタイル投稿」を押すと、普段使いの Chrome でスタイル登録画面を開き、Chrome拡張が
          FRONT 画像を自動でアップロードします（Playwright不使用・Akamai回避）。
        </p>
        <p className="mt-1 text-[10px]">
          ローカル連携: {bridgeOk === null ? '確認中…' : bridgeOk ? <span className="text-emerald-600">稼働中 ✅</span> : <span className="text-red-600">停止中 ⚠️（アプリ再起動を試してください）</span>}
        </p>
      </div>
      <div className="px-5 py-4">
        <div className="flex flex-col gap-3">
          <label className="flex flex-col gap-1">
            <span className="text-[10px] uppercase tracking-wide text-muted">画像URL（公開URL）</span>
            <input type="text" value={imageUrl} onChange={(e) => setImageUrl(e.target.value)} placeholder="https://…/image.jpg" className={ic} />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[10px] uppercase tracking-wide text-muted">開くSalonBoard URL（スタイル画面）</span>
            <input type="text" value={salonboardUrl} onChange={(e) => setSalonboardUrl(e.target.value)} className={ic} />
          </label>

          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={run}
              disabled={!canRun}
              className="inline-flex h-10 items-center gap-1.5 rounded-[12px] bg-brand-gradient px-5 text-[13px] font-semibold text-white shadow-brand-sm disabled:opacity-50"
            >
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Chrome className="h-4 w-4" />}
              {busy ? '実行中…' : 'スタイル投稿（Chrome拡張）'}
            </button>
            <span className={`text-[12px] font-semibold ${state === 'done' ? 'text-emerald-700' : state === 'failed' ? 'text-red-600' : 'text-ink-soft'}`}>
              {STATE_LABEL[state]}
            </span>
          </div>

          {lines.length > 0 && (
            <div className="mt-1 rounded-[10px] border border-hairline bg-surface-soft/60 p-3">
              <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted">実行ログ {jobId ? `(${jobId})` : ''}</div>
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
      </div>
    </Card>
  );
}
