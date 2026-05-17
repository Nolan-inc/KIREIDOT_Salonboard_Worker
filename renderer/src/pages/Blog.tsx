import { useEffect, useState } from 'react';
import { Plus, Send, Eye, Calendar, Loader2 } from 'lucide-react';
import { Card, CardBody } from '../components/Card';
import { useAuth } from '../lib/auth-context';
import { fetchPosts, type PostRow } from '../lib/data';
import { postStatusJp } from '../lib/format';
import { cn } from '../lib/cn';

export function Blog() {
  const auth = useAuth();
  const [loading, setLoading] = useState(true);
  const [posts, setPosts] = useState<PostRow[]>([]);

  useEffect(() => {
    if (auth.status !== 'signed-in') return;
    const scope = auth.scope;
    let cancelled = false;
    setLoading(true);
    fetchPosts(scope)
      .then((data) => !cancelled && setPosts(data))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [auth.status, auth.status === 'signed-in' ? auth.scope.shopId : null]);

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
          <button type="button" className="inline-flex h-9 items-center gap-1.5 rounded-[12px] bg-brand-gradient px-4 text-[13px] font-semibold text-white shadow-brand-sm transition hover:shadow-brand">
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
                  <div className="flex items-center justify-between">
                    <span className={cn('rounded-full px-2 py-0.5 text-[10px] font-bold', cfg.cls)}>
                      {cfg.label}
                    </span>
                    <span className="inline-flex items-center gap-1 text-[10px] text-muted">
                      <Eye className="h-3 w-3" />
                      {(p.view_count ?? 0).toLocaleString()}
                    </span>
                  </div>
                  <h3 className="font-serif text-[15px] font-bold leading-snug text-ink">
                    {p.title ?? '(無題)'}
                  </h3>
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
                    <button type="button" className="flex-1 rounded-[10px] border border-hairline bg-white py-1.5 text-[11px] font-semibold text-ink-soft hover:bg-brand-light/40">
                      編集
                    </button>
                    <button type="button" className="flex-1 rounded-[10px] bg-brand-light py-1.5 text-[11px] font-semibold text-brand-700 hover:bg-brand-200">
                      プレビュー
                    </button>
                  </div>
                </CardBody>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
