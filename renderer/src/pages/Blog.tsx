import { useEffect, useState } from 'react';
import {
  Plus,
  Send,
  Eye,
  Calendar,
  Loader2,
  FileText,
  ExternalLink,
  X,
  Trash2,
  AlertTriangle,
} from 'lucide-react';
import { Card, CardBody } from '../components/Card';
import { useEffectiveScope } from '../lib/selection-context';
import { fetchPosts, type PostRow } from '../lib/data';
import { postStatusJp } from '../lib/format';
import { cn } from '../lib/cn';

/** HTML を見出しレベル + 改行整形してプレーン化 (プレビュー用) */
function stripHtmlText(html: string | null | undefined): string {
  if (!html) return '';
  if (typeof window === 'undefined') {
    return html.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
  }
  const div = document.createElement('div');
  div.innerHTML = html;
  return (div.textContent || '').replace(/\s+/g, ' ').trim();
}

export function Blog() {
  const scope = useEffectiveScope();
  const [loading, setLoading] = useState(true);
  const [posts, setPosts] = useState<PostRow[]>([]);
  const [previewing, setPreviewing] = useState<PostRow | null>(null);
  const [composing, setComposing] = useState(false);
  const [deleting, setDeleting] = useState<PostRow | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    if (!scope) return;
    let cancelled = false;
    setLoading(true);
    fetchPosts(scope)
      .then((data) => !cancelled && setPosts(data))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [scope?.shopId, scope?.organizationId, reloadKey]);

  return (
    <div className="flex flex-col gap-5 pt-4">
      <div className="flex items-center justify-between">
        <p className="text-[13px] text-ink-soft">
          {loading ? '読み込み中…' : `全 ${posts.length} 件`}
        </p>
        <div className="flex items-center gap-2">
          <button type="button" className="inline-flex h-9 items-center gap-1.5 rounded-[12px] border border-hairline bg-white/80 px-4 text-[12px] font-semibold text-ink-soft hover:bg-brand-light/40">
            <Send className="h-3.5 w-3.5" /> サロンボードへ同期
          </button>
          <button
            type="button"
            onClick={() => setComposing(true)}
            disabled={!scope?.shopId}
            title={scope?.shopId ? '記事を作成' : '先に店舗を選択してください'}
            className="inline-flex h-9 items-center gap-1.5 rounded-[12px] bg-brand-gradient px-4 text-[13px] font-semibold text-white shadow-brand-sm transition hover:shadow-brand disabled:opacity-40"
          >
            <Plus className="h-3.5 w-3.5" /> 記事を書く
          </button>
        </div>
      </div>

      {loading ? (
        <Card>
          <div className="flex items-center gap-2 px-5 py-10 text-[13px] text-ink-soft">
            <Loader2 className="h-4 w-4 animate-spin" /> 読み込み中…
          </div>
        </Card>
      ) : posts.length === 0 ? (
        <Card>
          <div className="px-5 py-10 text-center text-[13px] text-ink-soft">
            ブログ記事はまだありません。「記事を書く」から作成できます。
          </div>
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {posts.map((p) => {
            const cfg = postStatusJp(p.status);
            return (
              <Card key={p.id} className="overflow-hidden">
                <div className="flex h-32 items-center justify-center bg-gradient-to-br from-brand-100 via-brand-50 to-white text-5xl">
                  {p.cover_image_url ? (
                    <img src={p.cover_image_url} alt="" className="h-full w-full object-cover" />
                  ) : (
                    <span>📝</span>
                  )}
                </div>
                <CardBody className="space-y-3">
                  <div className="flex items-center justify-between gap-1.5">
                    <div className="flex items-center gap-1.5">
                      <span
                        className={cn(
                          'rounded-full px-2 py-0.5 text-[10px] font-bold',
                          cfg.cls,
                        )}
                      >
                        {cfg.label}
                      </span>
                      <span
                        className={
                          p.source === 'kireidot'
                            ? 'rounded-full bg-brand-light/70 px-2 py-0.5 text-[10px] font-bold text-brand-700'
                            : 'rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-bold text-emerald-700'
                        }
                        title={
                          p.source === 'kireidot'
                            ? 'KIREIDOT で作成されたコンテンツ'
                            : 'SalonBoard から取り込まれたブログ'
                        }
                      >
                        {p.source === 'kireidot' ? 'KIREIDOT' : 'SalonBoard'}
                      </span>
                      {p.source === 'kireidot' && p.sync_to_salonboard && (
                        <span
                          className="rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-bold text-amber-700"
                          title="SalonBoard にも投稿する設定"
                        >
                          SB連携ON
                        </span>
                      )}
                    </div>
                    {p.view_count != null && (
                      <span className="inline-flex shrink-0 items-center gap-1 text-[10px] text-muted">
                        <Eye className="h-3 w-3" />
                        {p.view_count.toLocaleString()}
                      </span>
                    )}
                  </div>
                  <h3 className="font-serif text-[15px] font-bold leading-snug text-ink">
                    {p.title ?? '(無題)'}
                  </h3>
                  {p.body && (
                    <p className="line-clamp-3 text-[11px] leading-relaxed text-ink-soft">
                      {stripHtmlText(p.body).slice(0, 180)}
                    </p>
                  )}
                  <div className="flex items-center justify-between text-[10px] text-ink-soft">
                    <span>{p.author_id ? '担当スタッフ' : '-'}</span>
                    <span className="inline-flex items-center gap-1">
                      <Calendar className="h-3 w-3" />
                      {p.published_at
                        ? new Date(p.published_at).toLocaleDateString('ja-JP')
                        : '未公開'}
                    </span>
                  </div>
                  <div className="flex items-center gap-2 pt-1">
                    <button
                      type="button"
                      disabled={!p.body}
                      onClick={() => setPreviewing(p)}
                      className="flex-1 rounded-[10px] border border-hairline bg-white py-1.5 text-[11px] font-semibold text-ink-soft hover:bg-brand-light/40 disabled:opacity-50"
                    >
                      <FileText className="mr-1 inline h-3 w-3" /> 本文を見る
                    </button>
                    {p.source_url ? (
                      <a
                        href={p.source_url}
                        target="_blank"
                        rel="noreferrer"
                        className="flex-1 rounded-[10px] bg-brand-light py-1.5 text-center text-[11px] font-semibold text-brand-700 hover:bg-brand-200"
                      >
                        <ExternalLink className="mr-1 inline h-3 w-3" />
                        サロンボード
                      </a>
                    ) : (
                      <span className="flex-1 rounded-[10px] border border-hairline bg-white py-1.5 text-center text-[11px] font-semibold text-ink-soft">
                        URL なし
                      </span>
                    )}
                    {p.source === 'kireidot' && (
                      <button
                        type="button"
                        onClick={() => setDeleting(p)}
                        title="この記事を削除"
                        aria-label="この記事を削除"
                        className="shrink-0 rounded-[10px] border border-red-200 bg-white px-2.5 py-1.5 text-red-600 hover:bg-red-50"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </div>
                </CardBody>
              </Card>
            );
          })}
        </div>
      )}

      {/* 本文プレビューモーダル */}
      {previewing && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={() => setPreviewing(null)}
        >
          <div
            role="dialog"
            className="flex max-h-[85vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl bg-white shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between border-b border-hairline px-5 py-4">
              <div className="min-w-0">
                <div className="text-[10px] uppercase tracking-wider text-muted">
                  {previewing.source === 'salonboard' ? 'SalonBoard 取込ブログ' : 'KIREIDOT コンテンツ'}
                  {previewing.published_at && (
                    <span className="ml-2 text-ink-soft">
                      {new Date(previewing.published_at).toLocaleString('ja-JP')}
                    </span>
                  )}
                </div>
                <div className="mt-0.5 text-[14px] font-bold text-ink">
                  {previewing.title ?? '(無題)'}
                </div>
                {previewing.author_name && (
                  <div className="mt-0.5 text-[11px] text-ink-soft">
                    by {previewing.author_name}
                  </div>
                )}
              </div>
              <button
                type="button"
                onClick={() => setPreviewing(null)}
                className="text-ink-soft hover:text-ink"
                aria-label="閉じる"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="overflow-y-auto px-5 py-4">
              {previewing.cover_image_url && (
                <img
                  src={previewing.cover_image_url}
                  alt=""
                  className="mb-3 max-h-64 w-full rounded-lg object-cover"
                  referrerPolicy="no-referrer"
                />
              )}
              {previewing.body ? (
                <div
                  className="prose prose-sm max-w-none text-ink [&_img]:my-2 [&_img]:rounded-md"
                  // body は外部由来 HTML を含む。SB の取り込み時に script/style/iframe は除去済。
                  dangerouslySetInnerHTML={{ __html: previewing.body }}
                />
              ) : (
                <p className="text-[12px] text-ink-soft">
                  本文がまだ取得されていません。「ブログのみ同期」を実行すると本文が更新されます。
                </p>
              )}
            </div>
            {previewing.source === 'salonboard' && previewing.source_url && (
              <div className="border-t border-hairline px-5 py-3 text-right">
                <a
                  href={previewing.source_url}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1.5 rounded-[10px] border border-brand-300 bg-white px-3 py-1.5 text-[11px] font-semibold text-brand-700 hover:bg-brand-light/40"
                >
                  <ExternalLink className="h-3 w-3" /> サロンボードで開く
                </a>
              </div>
            )}
          </div>
        </div>
      )}

      {/* 削除確認モーダル */}
      {deleting && deleting.shop_id && (
        <DeleteModal
          post={deleting}
          onClose={() => setDeleting(null)}
          onDeleted={() => {
            setDeleting(null);
            // 楽観的に一覧から除去しつつ、少し後に再取得
            setPosts((prev) => prev.filter((x) => x.id !== deleting.id));
            setTimeout(() => setReloadKey((k) => k + 1), 600);
          }}
        />
      )}

      {/* 記事作成モーダル */}
      {composing && scope?.shopId && (
        <ComposeModal
          shopId={scope.shopId}
          onClose={() => setComposing(false)}
          onCreated={() => {
            setComposing(false);
            setTimeout(() => setReloadKey((k) => k + 1), 800);
          }}
        />
      )}
    </div>
  );
}

// 削除確認モーダル。KIREIDOT 側のブログ (content_posts) を削除する。
// SalonBoard に投稿済み (salonboard_external_id あり) の場合は、SalonBoard 側の記事は
// 自動削除されない旨を警告する。
function DeleteModal({
  post,
  onClose,
  onDeleted,
}: {
  post: PostRow;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const postedToSb = !!post.salonboard_external_id;

  async function confirmDelete() {
    const bridge = typeof window !== 'undefined' ? window.kireidotApp : undefined;
    if (!bridge?.deviceConfig?.deleteContent) {
      setError('この機能はデスクトップアプリでのみ利用できます');
      return;
    }
    if (!post.shop_id) {
      setError('店舗が特定できません');
      return;
    }
    setSubmitting(true);
    setError(null);
    const r = await bridge.deviceConfig.deleteContent({
      shopId: post.shop_id,
      contentPostId: post.id,
    });
    setSubmitting(false);
    if (r.ok) {
      onDeleted();
    } else {
      setError(`削除に失敗しました: ${r.error ?? 'unknown'}`);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div
        className="w-full max-w-md overflow-hidden rounded-2xl bg-white shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-hairline px-5 py-4">
          <div className="flex items-center gap-2 text-[15px] font-bold text-ink">
            <Trash2 className="h-4 w-4 text-red-500" /> 記事を削除
          </div>
          <button type="button" onClick={onClose} className="text-ink-soft hover:text-ink" aria-label="閉じる">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="space-y-3 px-5 py-4">
          <p className="text-[13px] text-ink">
            「<span className="font-semibold">{post.title ?? '(無題)'}</span>」を削除します。よろしいですか？
          </p>
          {postedToSb && (
            <div className="flex items-start gap-2 rounded-lg bg-amber-50 px-3 py-2 text-[12px] text-amber-800">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>
                この記事は SalonBoard に投稿済みです。削除すると
                <b>SalonBoard 側のブログも自動的に削除されます</b>（数十秒後に反映）。
              </span>
            </div>
          )}
          {error && (
            <div className="rounded-lg bg-red-50 px-3 py-2 text-[12px] text-red-700">{error}</div>
          )}
        </div>
        <div className="flex justify-end gap-2 border-t border-hairline px-5 py-3">
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="rounded-lg border border-hairline px-4 py-1.5 text-[13px] font-semibold text-ink-soft hover:bg-brand-light/40 disabled:opacity-40"
          >
            キャンセル
          </button>
          <button
            type="button"
            onClick={confirmDelete}
            disabled={submitting}
            className="inline-flex items-center gap-1.5 rounded-lg bg-red-600 px-4 py-1.5 text-[13px] font-semibold text-white hover:bg-red-700 disabled:opacity-40"
          >
            {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
            {submitting ? '削除中…' : '削除する'}
          </button>
        </div>
      </div>
    </div>
  );
}

// 記事作成モーダル。タイトル/本文/カバー画像/SB連携を入力 → device API でブログ作成。
// 公開 + SB連携ON のとき push_blog ジョブが積まれ、予約同期くんが SalonBoard へ自動投稿する。
function ComposeModal({
  shopId,
  onClose,
  onCreated,
}: {
  shopId: string;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [coverUrl, setCoverUrl] = useState('');
  const [syncSb, setSyncSb] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; msg: string } | null>(null);

  async function submit() {
    const bridge = typeof window !== 'undefined' ? window.kireidotApp : undefined;
    if (!bridge?.deviceConfig?.createContent) {
      setResult({ ok: false, msg: 'この機能はデスクトップアプリでのみ利用できます' });
      return;
    }
    if (!title.trim()) {
      setResult({ ok: false, msg: 'タイトルを入力してください' });
      return;
    }
    setSubmitting(true);
    setResult(null);
    const r = await bridge.deviceConfig.createContent({
      shopId,
      title: title.trim(),
      body: body.trim() || null,
      coverImageUrl: coverUrl.trim() || null,
      syncToSalonboard: syncSb,
      publish: true,
    });
    setSubmitting(false);
    if (r.ok) {
      setResult({
        ok: true,
        msg: syncSb
          ? (r.enqueued
              ? '✅ 記事を作成しました。SalonBoard へ自動投稿します（数分後に反映）。'
              : '✅ 記事を作成しました（SalonBoard 投稿ジョブは積まれませんでした。連携設定をご確認ください）。')
          : '✅ 記事を作成しました（SalonBoard には投稿しません）。',
      });
      setTimeout(onCreated, 1200);
    } else {
      setResult({ ok: false, msg: `失敗: ${r.error ?? 'unknown'}` });
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div
        className="flex max-h-[88vh] w-full max-w-xl flex-col overflow-hidden rounded-2xl bg-white shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-hairline px-5 py-4">
          <div className="text-[15px] font-bold text-ink">記事を書く</div>
          <button type="button" onClick={onClose} className="text-ink-soft hover:text-ink" aria-label="閉じる">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="space-y-4 overflow-y-auto px-5 py-4">
          <label className="block">
            <span className="mb-1 block text-[12px] font-semibold text-ink-soft">タイトル *</span>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="例: 6月のおすすめメニュー"
              className="w-full rounded-lg border border-hairline px-3 py-2 text-[14px] text-ink"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-[12px] font-semibold text-ink-soft">本文</span>
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={8}
              placeholder="本文を入力（改行可）"
              className="w-full resize-y rounded-lg border border-hairline px-3 py-2 text-[13px] leading-relaxed text-ink"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-[12px] font-semibold text-ink-soft">カバー画像URL (任意)</span>
            <input
              value={coverUrl}
              onChange={(e) => setCoverUrl(e.target.value)}
              placeholder="https://…"
              className="w-full rounded-lg border border-hairline px-3 py-2 text-[13px] text-ink"
            />
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={syncSb} onChange={(e) => setSyncSb(e.target.checked)} className="h-4 w-4" />
            <span className="text-[13px] text-ink">SalonBoard にも自動投稿する</span>
          </label>
          {result && (
            <div className={`rounded-lg px-3 py-2 text-[12px] ${result.ok ? 'bg-emerald-50 text-emerald-700' : 'bg-red-50 text-red-700'}`}>
              {result.msg}
            </div>
          )}
        </div>
        <div className="flex justify-end gap-2 border-t border-hairline px-5 py-3">
          <button type="button" onClick={onClose} className="rounded-lg border border-hairline px-4 py-1.5 text-[13px] font-semibold text-ink-soft hover:bg-brand-light/40">
            キャンセル
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={submitting || !title.trim()}
            className="inline-flex items-center gap-1.5 rounded-lg bg-brand-gradient px-4 py-1.5 text-[13px] font-semibold text-white disabled:opacity-40"
          >
            {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
            {submitting ? '作成中…' : '作成して公開'}
          </button>
        </div>
      </div>
    </div>
  );
}
