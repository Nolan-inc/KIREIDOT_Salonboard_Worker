import { useEffect, useState } from 'react';
import { Loader2, Ticket, RefreshCcw } from 'lucide-react';
import { Card } from '../components/Card';
import { useEffectiveScope } from '../lib/selection-context';
import { fetchCouponList, type CouponRow } from '../lib/data';
import { useSyncController } from '../lib/sync-controller';

export function Coupons() {
  const scope = useEffectiveScope();
  const sync = useSyncController();
  const [loading, setLoading] = useState(true);
  const [coupons, setCoupons] = useState<CouponRow[]>([]);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    if (!scope) return;
    let cancelled = false;
    setLoading(true);
    fetchCouponList(scope)
      .then((data) => !cancelled && setCoupons(data))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [scope?.shopId, reloadKey]);

  const canSync = !!scope?.shopId && sync.ready && !sync.isRunning;

  async function syncCoupons() {
    if (!scope?.shopId) return;
    await sync.syncShops([scope.shopId], ['coupons']);
    // 同期完了後に再取得 (sync は非同期完了。少し待って reload)
    setTimeout(() => setReloadKey((k) => k + 1), 1500);
  }

  return (
    <div className="flex flex-col gap-5 pt-4">
      <div className="flex flex-col items-stretch gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <h1 className="text-[20px] font-bold text-ink">クーポン</h1>
          <p className="mt-0.5 text-[13px] text-ink-soft">
            {loading
              ? '読み込み中…'
              : `SalonBoard 取得クーポン ${coupons.length} 件`}
          </p>
        </div>
        <button
          type="button"
          onClick={syncCoupons}
          disabled={!canSync}
          title={scope?.shopId ? 'SalonBoard からクーポンを取得' : '先に店舗を選択してください'}
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
        ) : coupons.length === 0 ? (
          <div className="px-5 py-10 text-center text-[13px] text-ink-soft">
            クーポンがありません。
            <br />
            「サロンボードから取得」を押すと SalonBoard のクーポンを取り込めます。
          </div>
        ) : (
          <table className="w-full text-left text-[13px]">
            <thead className="border-b border-hairline/70 bg-white/50">
              <tr className="text-[11px] uppercase tracking-wider text-muted">
                <th className="px-5 py-3">写真</th>
                <th className="px-3 py-3">クーポン名 / 内容</th>
                <th className="px-3 py-3">種別</th>
                <th className="px-3 py-3 text-right">金額</th>
                <th className="px-3 py-3">所要</th>
                <th className="px-3 py-3">有効期限</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-hairline/60">
              {coupons.map((c) => (
                <tr key={c.id} className="transition hover:bg-brand-light/30">
                  <td className="px-5 py-3 align-top">
                    {c.photo_url ? (
                      <img
                        src={c.photo_url}
                        alt=""
                        className="h-10 w-10 rounded-md object-cover"
                        loading="lazy"
                      />
                    ) : (
                      <div className="flex h-10 w-10 items-center justify-center rounded-md bg-surface-soft">
                        <Ticket className="h-4 w-4 text-muted-faint" />
                      </div>
                    )}
                  </td>
                  <td className="px-3 py-3 align-top">
                    <div className="font-medium text-ink line-clamp-2">{c.name}</div>
                    {c.content && (
                      <div className="mt-0.5 text-[11px] text-ink-soft line-clamp-2">{c.content}</div>
                    )}
                    {c.use_condition && (
                      <div className="mt-0.5 text-[10px] text-muted">条件: {c.use_condition}</div>
                    )}
                  </td>
                  <td className="px-3 py-3 align-top">
                    {c.category ? (
                      <span className="rounded-full bg-sky-100 px-2 py-0.5 text-[10px] font-bold text-sky-700">
                        {c.category}
                      </span>
                    ) : (
                      <span className="text-ink-soft">—</span>
                    )}
                  </td>
                  <td className="px-3 py-3 text-right align-top font-semibold text-ink">
                    {c.price != null ? `¥${c.price.toLocaleString('ja-JP')}` : '—'}
                  </td>
                  <td className="px-3 py-3 align-top text-ink-soft">
                    {c.duration_min != null ? `${c.duration_min}分` : '—'}
                  </td>
                  <td className="px-3 py-3 align-top text-ink-soft">{c.expires_label ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}
