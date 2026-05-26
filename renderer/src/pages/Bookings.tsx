import { useEffect, useMemo, useState } from 'react';
import { Plus, ChevronLeft, ChevronRight, Search, Filter, Loader2 } from 'lucide-react';
import { Card } from '../components/Card';
import { useEffectiveScope } from '../lib/selection-context';
import { fetchRecentBookings, type BookingRow } from '../lib/data';
import { bookingStatusJp, formatTime, formatYen } from '../lib/format';

const FILTERS = ['すべて', 'confirmed', 'pending', 'completed', 'cancelled'] as const;
const FILTER_LABELS: Record<(typeof FILTERS)[number], string> = {
  すべて: 'すべて',
  confirmed: '確定',
  pending: '仮押え',
  completed: '完了',
  cancelled: 'キャンセル',
};

export function Bookings() {
  const scope = useEffectiveScope();
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>('すべて');
  const [loading, setLoading] = useState(true);
  const [bookings, setBookings] = useState<BookingRow[]>([]);
  const [search, setSearch] = useState('');

  useEffect(() => {
    if (!scope) return;
    let cancelled = false;
    setLoading(true);
    fetchRecentBookings(scope, 7)
      .then((data) => {
        if (cancelled) return;
        setBookings(data);
      })
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [scope?.shopId, scope?.organizationId]);

  const displayName = (b: BookingRow) =>
    b.customers?.full_name ??
    b.profiles?.full_name ??
    b.customer_name ??
    'ゲスト';

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return bookings.filter((b) => {
      if (filter !== 'すべて' && b.status !== filter) return false;
      if (q) {
        const name = displayName(b).toLowerCase();
        const menu = (b.menus?.name ?? '').toLowerCase();
        if (!name.includes(q) && !menu.includes(q)) return false;
      }
      return true;
    });
  }, [bookings, filter, search]);

  return (
    <div className="flex flex-col gap-5 pt-4">
      <div className="flex flex-col items-stretch gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex items-center gap-2">
          <button type="button" className="inline-flex h-9 w-9 items-center justify-center rounded-full border border-hairline bg-white/80 text-ink-soft hover:bg-brand-light/50">
            <ChevronLeft className="h-4 w-4" />
          </button>
          <div className="rounded-[12px] border border-hairline bg-white/85 px-4 py-2">
            <div className="text-[10px] uppercase tracking-wider text-muted">今週</div>
            <div className="font-serif text-[16px] font-bold text-ink">
              {new Date().toLocaleDateString('ja-JP', { month: 'long', day: 'numeric', weekday: 'short' })} から 7 日
            </div>
          </div>
          <button type="button" className="inline-flex h-9 w-9 items-center justify-center rounded-full border border-hairline bg-white/80 text-ink-soft hover:bg-brand-light/50">
            <ChevronRight className="h-4 w-4" />
          </button>
        </div>
        <div className="flex items-center gap-2">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-faint" size={14} />
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="顧客名 / メニュー"
              className="h-9 w-60 rounded-[12px] border border-hairline bg-white/85 pl-9 pr-3 text-[13px] focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/20"
            />
          </div>
          <button type="button" className="inline-flex h-9 items-center gap-1.5 rounded-[12px] border border-hairline bg-white/80 px-3 text-[12px] font-semibold text-ink-soft hover:bg-brand-light/40">
            <Filter className="h-3.5 w-3.5" /> 絞り込み
          </button>
          <button type="button" className="inline-flex h-9 items-center gap-1.5 rounded-[12px] bg-brand-gradient px-4 text-[13px] font-semibold text-white shadow-brand-sm transition hover:shadow-brand">
            <Plus className="h-3.5 w-3.5" /> 新規予約
          </button>
        </div>
      </div>

      <div className="flex items-center gap-1.5 overflow-x-auto">
        {FILTERS.map((f) => (
          <button
            key={f}
            type="button"
            onClick={() => setFilter(f)}
            className={
              filter === f
                ? 'inline-flex h-8 items-center rounded-full bg-brand-gradient px-3.5 text-[12px] font-semibold text-white shadow-brand-sm'
                : 'inline-flex h-8 items-center rounded-full border border-hairline bg-white/70 px-3.5 text-[12px] font-semibold text-ink-soft hover:bg-brand-light/40'
            }
          >
            {FILTER_LABELS[f]}
          </button>
        ))}
      </div>

      <Card className="overflow-hidden">
        {loading ? (
          <div className="flex items-center gap-2 px-5 py-10 text-[13px] text-ink-soft">
            <Loader2 className="h-4 w-4 animate-spin" /> 読み込み中…
          </div>
        ) : filtered.length === 0 ? (
          <div className="px-5 py-10 text-center text-[13px] text-ink-soft">該当する予約がありません。</div>
        ) : (
          <table className="w-full text-left text-[13px]">
            <thead className="border-b border-hairline/70 bg-white/50">
              <tr className="text-[11px] uppercase tracking-wider text-muted">
                <th className="px-5 py-3">日時</th>
                <th className="px-3 py-3">顧客</th>
                <th className="px-3 py-3">区分</th>
                <th className="px-3 py-3">メニュー</th>
                <th className="px-3 py-3">店舗</th>
                <th className="px-3 py-3 text-right">金額</th>
                <th className="px-3 py-3">状態</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-hairline/60">
              {filtered.map((b) => {
                const status = bookingStatusJp(b.status);
                const isMember = !!b.user_id;
                const customerName = displayName(b);
                const staffName = b.salonboard_staff_name ?? b.staff?.full_name ?? '-';
                return (
                  <tr key={b.id} className="transition hover:bg-brand-light/30">
                    <td className="px-5 py-3">
                      <div className="font-serif text-[15px] font-bold text-ink">{formatTime(b.scheduled_at)}</div>
                      <div className="text-[10px] text-muted">
                        {new Date(b.scheduled_at).toLocaleDateString('ja-JP', { month: 'numeric', day: 'numeric', weekday: 'short' })}
                        ・{b.duration_min ?? 60}分
                      </div>
                    </td>
                    <td className="px-3 py-3 font-semibold text-ink">{customerName}</td>
                    <td className="px-3 py-3">
                      <span
                        className={
                          isMember
                            ? 'rounded-full bg-brand-100 px-1.5 py-0.5 text-[10px] font-bold text-brand-700'
                            : 'rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-bold text-amber-700'
                        }
                      >
                        {isMember ? '会員' : 'ゲスト'}
                      </span>
                    </td>
                    <td className="px-3 py-3 text-ink-soft">{b.menus?.name ?? '-'}</td>
                    <td className="px-3 py-3 text-ink-soft">{b.shops?.name ?? '-'}</td>
                    <td className="px-3 py-3 text-right font-semibold text-ink">{formatYen(b.amount)}</td>
                    <td className="px-3 py-3">
                      <span className={`inline-block rounded-full px-2 py-0.5 text-[10px] font-bold ${status.cls}`}>{status.label}</span>
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
