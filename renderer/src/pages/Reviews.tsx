import { useEffect, useState } from 'react';
import { Loader2, MessageSquareText, RefreshCcw, Sparkles, Copy, Check, ExternalLink } from 'lucide-react';
import { Card } from '../components/Card';
import { useEffectiveScope } from '../lib/selection-context';
import { fetchReviewList, saveReviewAiReply, type ReviewRow } from '../lib/data';
import { generateReviewReply } from '../lib/salonboard';
import { useSyncController } from '../lib/sync-controller';

export function Reviews() {
  const scope = useEffectiveScope();
  const sync = useSyncController();
  const [loading, setLoading] = useState(true);
  const [reviews, setReviews] = useState<ReviewRow[]>([]);
  const [reloadKey, setReloadKey] = useState(0);
  const [filter, setFilter] = useState<'all' | 'unreplied'>('all');

  // 各口コミの AI 生成状態
  const [genId, setGenId] = useState<string | null>(null); // 生成中の review.id
  const [errById, setErrById] = useState<Record<string, string>>({});
  const [copiedId, setCopiedId] = useState<string | null>(null);

  useEffect(() => {
    if (!scope) return;
    let cancelled = false;
    setLoading(true);
    fetchReviewList(scope)
      .then((data) => !cancelled && setReviews(data))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [scope?.shopId, reloadKey]);

  const canSync = !!scope?.shopId && sync.ready && !sync.isRunning;

  async function syncReviews() {
    if (!scope?.shopId) return;
    await sync.syncShops([scope.shopId], ['reviews']);
    setTimeout(() => setReloadKey((k) => k + 1), 1500);
  }

  async function generateReply(r: ReviewRow) {
    setGenId(r.id);
    setErrById((p) => ({ ...p, [r.id]: '' }));
    try {
      const res = await generateReviewReply(r.id);
      if (!res.ok) {
        setErrById((p) => ({ ...p, [r.id]: res.error }));
        return;
      }
      // 楽観更新 (Admin 側でも保存済みだが、RLS update 経由でも保険的に保存)
      await saveReviewAiReply(r.id, res.reply).catch(() => {});
      setReviews((prev) =>
        prev.map((x) =>
          x.id === r.id
            ? { ...x, ai_reply_draft: res.reply, ai_reply_generated_at: new Date().toISOString() }
            : x,
        ),
      );
    } finally {
      setGenId(null);
    }
  }

  async function copyReply(r: ReviewRow) {
    if (!r.ai_reply_draft) return;
    try {
      await navigator.clipboard.writeText(r.ai_reply_draft);
      setCopiedId(r.id);
      setTimeout(() => setCopiedId((c) => (c === r.id ? null : c)), 1500);
    } catch {
      /* noop */
    }
  }

  const shown = reviews.filter((r) => (filter === 'unreplied' ? r.reply_status === 'unreplied' : true));
  const unrepliedCount = reviews.filter((r) => r.reply_status === 'unreplied').length;

  return (
    <div className="flex flex-col gap-5 pt-4">
      <div className="flex flex-col items-stretch gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <h1 className="text-[20px] font-bold text-ink">口コミ</h1>
          <p className="mt-0.5 text-[13px] text-ink-soft">
            {loading
              ? '読み込み中…'
              : `SalonBoard 取得 ${reviews.length} 件 / 未返信 ${unrepliedCount} 件`}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex overflow-hidden rounded-[12px] border border-hairline text-[12px]">
            <button
              type="button"
              onClick={() => setFilter('all')}
              className={
                'px-3 py-1.5 font-semibold ' +
                (filter === 'all' ? 'bg-brand text-white' : 'bg-white/80 text-ink-soft hover:bg-brand-light/40')
              }
            >
              すべて
            </button>
            <button
              type="button"
              onClick={() => setFilter('unreplied')}
              className={
                'px-3 py-1.5 font-semibold ' +
                (filter === 'unreplied'
                  ? 'bg-brand text-white'
                  : 'bg-white/80 text-ink-soft hover:bg-brand-light/40')
              }
            >
              未返信のみ
            </button>
          </div>
          <button
            type="button"
            onClick={syncReviews}
            disabled={!canSync}
            title={scope?.shopId ? 'SalonBoard から口コミを取得' : '先に店舗を選択してください'}
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
      </div>

      {loading ? (
        <Card>
          <div className="flex items-center gap-2 px-5 py-10 text-[13px] text-ink-soft">
            <Loader2 className="h-4 w-4 animate-spin" /> 読み込み中…
          </div>
        </Card>
      ) : shown.length === 0 ? (
        <Card>
          <div className="px-5 py-10 text-center text-[13px] text-ink-soft">
            {reviews.length === 0 ? (
              <>
                口コミがありません。
                <br />
                「サロンボードから取得」を押すと SalonBoard の口コミを取り込めます。
              </>
            ) : (
              '未返信の口コミはありません。'
            )}
          </div>
        </Card>
      ) : (
        <div className="flex flex-col gap-3">
          {shown.map((r) => (
            <Card key={r.id} className="p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-semibold text-ink">{r.customer_name || '匿名'} 様</span>
                    {r.reply_status === 'unreplied' ? (
                      <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-bold text-amber-700">
                        未返信
                      </span>
                    ) : (
                      <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-bold text-emerald-700">
                        返信済
                      </span>
                    )}
                    {r.audit_status && (
                      <span className="text-[10px] text-muted">{r.audit_status}</span>
                    )}
                  </div>
                  <div className="mt-0.5 text-[11px] text-muted">
                    {r.staff_name ? `担当: ${r.staff_name}　` : ''}
                    {r.visit_date_label ? `来店: ${r.visit_date_label}　` : ''}
                    {r.posted_at_label ? `投稿: ${r.posted_at_label}` : ''}
                  </div>
                </div>
                {r.reply_url && (
                  <a
                    href={`https://salonboard.com${r.reply_url}`}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex shrink-0 items-center gap-1 text-[11px] text-ink-soft hover:text-brand"
                    title="SalonBoard の返信ページを開く"
                  >
                    <ExternalLink className="h-3 w-3" /> SBで開く
                  </a>
                )}
              </div>

              <p className="mt-2 whitespace-pre-wrap text-[13px] text-ink">{r.body_excerpt || '(本文なし)'}</p>

              {/* AI 返信案 */}
              {r.ai_reply_draft ? (
                <div className="mt-3 rounded-[12px] border border-brand/30 bg-brand-light/30 p-3">
                  <div className="mb-1 flex items-center justify-between">
                    <span className="inline-flex items-center gap-1 text-[11px] font-bold text-brand">
                      <Sparkles className="h-3 w-3" /> AI返信案
                    </span>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => copyReply(r)}
                        className="inline-flex items-center gap-1 text-[11px] font-semibold text-ink-soft hover:text-brand"
                      >
                        {copiedId === r.id ? (
                          <>
                            <Check className="h-3 w-3" /> コピーしました
                          </>
                        ) : (
                          <>
                            <Copy className="h-3 w-3" /> コピー
                          </>
                        )}
                      </button>
                      <button
                        type="button"
                        onClick={() => generateReply(r)}
                        disabled={genId === r.id}
                        className="inline-flex items-center gap-1 text-[11px] font-semibold text-ink-soft hover:text-brand disabled:opacity-50"
                      >
                        {genId === r.id ? (
                          <Loader2 className="h-3 w-3 animate-spin" />
                        ) : (
                          <RefreshCcw className="h-3 w-3" />
                        )}
                        作り直す
                      </button>
                    </div>
                  </div>
                  <p className="whitespace-pre-wrap text-[13px] text-ink">{r.ai_reply_draft}</p>
                </div>
              ) : (
                <div className="mt-3">
                  <button
                    type="button"
                    onClick={() => generateReply(r)}
                    disabled={genId === r.id}
                    className="inline-flex h-9 items-center gap-1.5 rounded-[12px] bg-brand px-4 text-[12px] font-semibold text-white hover:bg-brand/90 disabled:opacity-50"
                  >
                    {genId === r.id ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Sparkles className="h-3.5 w-3.5" />
                    )}
                    AIで返信案を作成
                  </button>
                </div>
              )}
              {errById[r.id] && (
                <p className="mt-2 text-[11px] text-red-600">{errById[r.id]}</p>
              )}
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
