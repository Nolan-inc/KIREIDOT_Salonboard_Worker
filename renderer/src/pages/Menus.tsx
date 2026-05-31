import { useEffect, useMemo, useState } from 'react';
import { Loader2, BookOpen, CheckCircle2, RefreshCcw } from 'lucide-react';
import { Card } from '../components/Card';
import { useEffectiveScope } from '../lib/selection-context';
import { fetchMenusMerged, type MergedMenuRow } from '../lib/data';
import { useSyncController } from '../lib/sync-controller';

const SOURCE_FILTERS = ['すべて', 'salonboard', 'kireidot'] as const;
type SourceFilter = (typeof SOURCE_FILTERS)[number];
const SOURCE_LABELS: Record<SourceFilter, string> = {
  すべて: 'すべて',
  salonboard: 'SalonBoard取得',
  kireidot: 'KIREIDOT登録',
};

function sourceBadge(source: 'salonboard' | 'kireidot') {
  return source === 'salonboard'
    ? { label: 'SalonBoard', cls: 'bg-sky-100 text-sky-700' }
    : { label: 'KIREIDOT', cls: 'bg-brand-100 text-brand-700' };
}

const yen = (n: number | null) => (n == null ? '—' : `¥${n.toLocaleString('ja-JP')}`);

export function Menus() {
  const scope = useEffectiveScope();
  const sync = useSyncController();
  const [loading, setLoading] = useState(true);
  const [menus, setMenus] = useState<MergedMenuRow[]>([]);
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>('すべて');
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    if (!scope) return;
    let cancelled = false;
    setLoading(true);
    fetchMenusMerged(scope)
      .then((data) => !cancelled && setMenus(data))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [scope?.shopId, scope?.organizationId, reloadKey]);

  const counts = useMemo(() => {
    let sb = 0;
    let kd = 0;
    for (const m of menus) {
      if (m.source === 'salonboard') sb++;
      else kd++;
    }
    return { all: menus.length, salonboard: sb, kireidot: kd };
  }, [menus]);

  const filtered = useMemo(
    () => menus.filter((m) => sourceFilter === 'すべて' || m.source === sourceFilter),
    [menus, sourceFilter],
  );

  const canSyncMenus = !!scope?.shopId && sync.ready && !sync.isRunning;

  async function syncMenus() {
    if (!scope?.shopId) return;
    await sync.syncShops([scope.shopId], ['menus']);
    // 同期完了後に再取得 (sync は非同期完了。少し待って reload)
    setTimeout(() => setReloadKey((k) => k + 1), 1500);
  }

  return (
    <div className="flex flex-col gap-5 pt-4">
      <div className="flex flex-col items-stretch gap-3 lg:flex-row lg:items-center lg:justify-between">
        <p className="text-[13px] text-ink-soft">
          {loading ? '読み込み中…' : `全 ${menus.length} 件 (SalonBoard ${counts.salonboard} / KIREIDOT ${counts.kireidot})`}
        </p>
        <button
          type="button"
          onClick={syncMenus}
          disabled={!canSyncMenus}
          title={scope?.shopId ? 'SalonBoard からメニューを取得' : '先に店舗を選択してください'}
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

      {/* 出所フィルタ */}
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-[11px] font-semibold text-muted">出所:</span>
        {SOURCE_FILTERS.map((f) => {
          const n =
            f === 'すべて' ? counts.all : f === 'salonboard' ? counts.salonboard : counts.kireidot;
          return (
            <button
              key={f}
              type="button"
              onClick={() => setSourceFilter(f)}
              className={
                sourceFilter === f
                  ? 'inline-flex h-7 items-center gap-1 rounded-full bg-ink px-3 text-[11px] font-semibold text-white'
                  : 'inline-flex h-7 items-center gap-1 rounded-full border border-hairline bg-white/70 px-3 text-[11px] font-semibold text-ink-soft hover:bg-brand-light/40'
              }
            >
              {SOURCE_LABELS[f]}
              <span className="opacity-70">({n})</span>
            </button>
          );
        })}
      </div>

      <Card className="overflow-hidden">
        {loading ? (
          <div className="flex items-center gap-2 px-5 py-10 text-[13px] text-ink-soft">
            <Loader2 className="h-4 w-4 animate-spin" /> 読み込み中…
          </div>
        ) : filtered.length === 0 ? (
          <div className="px-5 py-10 text-center text-[13px] text-ink-soft">
            メニューがありません。
            {counts.salonboard === 0 && (
              <>
                <br />
                「サロンボードから取得」を押すと SalonBoard のメニューを取り込めます。
              </>
            )}
          </div>
        ) : (
          <table className="w-full text-left text-[13px]">
            <thead className="border-b border-hairline/70 bg-white/50">
              <tr className="text-[11px] uppercase tracking-wider text-muted">
                <th className="px-5 py-3">出所</th>
                <th className="px-3 py-3">メニュー名</th>
                <th className="px-3 py-3">カテゴリ</th>
                <th className="px-3 py-3 text-right">価格</th>
                <th className="px-3 py-3">所要</th>
                <th className="px-3 py-3">状態</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-hairline/60">
              {filtered.map((m) => {
                const badge = sourceBadge(m.source);
                return (
                  <tr key={m.id} className="transition hover:bg-brand-light/30">
                    <td className="px-5 py-3">
                      <span className="inline-flex items-center gap-1">
                        <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${badge.cls}`}>
                          {badge.label}
                        </span>
                        {m.source === 'salonboard' && m.linked && (
                          <span
                            title="KIREIDOT メニューと紐付け済み"
                            className="inline-flex items-center gap-0.5 rounded-full bg-emerald-100 px-1.5 py-0.5 text-[9px] font-bold text-emerald-700"
                          >
                            <CheckCircle2 className="h-2.5 w-2.5" />紐付
                          </span>
                        )}
                      </span>
                    </td>
                    <td className="px-3 py-3 font-medium text-ink">
                      <span className="inline-flex items-center gap-1.5">
                        <BookOpen className="h-3 w-3 shrink-0 text-muted-faint" />
                        <span className="line-clamp-1">{m.name}</span>
                      </span>
                    </td>
                    <td className="px-3 py-3 text-ink-soft">{m.category ?? '—'}</td>
                    <td className="px-3 py-3 text-right font-semibold text-ink">
                      {yen(m.price)}
                      {m.discount_rate ? (
                        <span className="ml-1 text-[10px] font-bold text-red-600">
                          {m.discount_rate}%OFF
                        </span>
                      ) : null}
                    </td>
                    <td className="px-3 py-3 text-ink-soft">
                      {m.duration_min ? `${m.duration_min}分` : '—'}
                    </td>
                    <td className="px-3 py-3">
                      <span
                        className={`inline-block rounded-full px-2 py-0.5 text-[10px] font-bold ${
                          m.is_active ? 'bg-emerald-100 text-emerald-700' : 'bg-gray-100 text-gray-500'
                        }`}
                      >
                        {m.is_active ? '有効' : '無効'}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}
