import { useEffect, useState } from 'react';
import {
  CalendarRange,
  TrendingUp,
  Users,
  UserPlus,
  CalendarClock,
  Newspaper,
  ArrowUpRight,
  Sparkles,
  Loader2,
} from 'lucide-react';
import { Card, CardBody, CardHeader, SectionTitle } from '../components/Card';
import { useEffectiveScope } from '../lib/selection-context';
import {
  fetchDashboardSummary,
  fetchTodayBookings,
  type BookingRow,
  type DashboardSummary,
} from '../lib/data';
import { bookingStatusJp, formatTime, formatYen } from '../lib/format';
import type { NavKey } from '../lib/nav';

export function Dashboard({ onNavigate }: { onNavigate: (k: NavKey) => void }) {
  const scope = useEffectiveScope();
  const [loading, setLoading] = useState(true);
  const [summary, setSummary] = useState<DashboardSummary | null>(null);
  const [bookings, setBookings] = useState<BookingRow[]>([]);

  useEffect(() => {
    if (!scope) return;
    let cancelled = false;
    setLoading(true);
    Promise.all([fetchDashboardSummary(scope), fetchTodayBookings(scope)])
      .then(([s, b]) => {
        if (cancelled) return;
        setSummary(s);
        setBookings(b);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [scope?.shopId, scope?.organizationId]);

  return (
    <div className="flex flex-col gap-8 pt-4">
      {/* Hero カード */}
      <section className="relative overflow-hidden rounded-hero bg-gradient-to-br from-brand-100 via-brand-50 to-white p-7 shadow-card">
        <div aria-hidden className="absolute -right-16 -top-16 h-56 w-56 rounded-full bg-brand-200/55 blur-3xl" />
        <div aria-hidden className="absolute -bottom-20 -left-10 h-60 w-60 rounded-full bg-brand-100/70 blur-3xl" />
        <div className="relative z-10 flex items-center justify-between gap-6">
          <div>
            <span className="eyebrow">Today&apos;s Overview</span>
            <h2 className="mt-3 font-serif text-[28px] font-bold leading-tight text-ink">
              今日も<span className="text-highlight">良い 1 日</span>を、
              <br />
              KIREIDOT サロンデスクから。
            </h2>
            <p className="mt-2 max-w-[42ch] text-[13px] leading-relaxed text-ink-soft">
              予約 ・ スタッフ ・ シフト ・ ブログ ・ サロンボード連携。 サロン運営に必要な道具を、ぜんぶここから。
            </p>
          </div>
          <button
            type="button"
            onClick={() => onNavigate('bookings')}
            className="hidden items-center gap-1.5 rounded-full bg-brand-gradient px-5 py-2.5 text-[13px] font-semibold text-white shadow-brand-sm transition hover:shadow-brand md:inline-flex"
          >
            予約を確認する <ArrowUpRight className="h-3.5 w-3.5" />
          </button>
        </div>
      </section>

      {/* 統計カード */}
      <section>
        <SectionTitle icon={<Sparkles className="h-3 w-3" />}>サマリー</SectionTitle>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Stat
            icon={<CalendarRange className="h-4 w-4" />}
            label="今日の予約"
            value={summary ? `${summary.todayBookings} 件` : '—'}
            loading={loading}
          />
          <Stat
            icon={<TrendingUp className="h-4 w-4" />}
            label="今日の売上"
            value={summary ? formatYen(summary.todayRevenue) : '—'}
            loading={loading}
          />
          <Stat
            icon={<Users className="h-4 w-4" />}
            label="アクティブスタッフ"
            value={summary ? `${summary.activeStaff} 名` : '—'}
            loading={loading}
          />
          <Stat
            icon={<UserPlus className="h-4 w-4" />}
            label="新規顧客 (今日)"
            value={summary ? `${summary.newCustomersToday} 名` : '—'}
            loading={loading}
          />
        </div>
      </section>

      {/* 2 カラム */}
      <section className="grid grid-cols-1 gap-5 xl:grid-cols-[1.4fr_1fr]">
        {/* 今日の予約 */}
        <Card>
          <CardHeader
            title="今日の予約"
            subtitle={`本日 ${bookings.length} 件`}
            action={
              <button
                type="button"
                onClick={() => onNavigate('bookings')}
                className="inline-flex items-center gap-1 text-[12px] font-semibold text-brand-700 hover:underline"
              >
                すべて見る <ArrowUpRight className="h-3 w-3" />
              </button>
            }
          />
          <CardBody className="p-0">
            {loading ? (
              <div className="flex items-center gap-2 px-5 py-10 text-[13px] text-ink-soft">
                <Loader2 className="h-4 w-4 animate-spin" /> 読み込み中…
              </div>
            ) : bookings.length === 0 ? (
              <div className="px-5 py-10 text-center text-[13px] text-ink-soft">
                本日の予約はありません。
              </div>
            ) : (
              <ul className="divide-y divide-hairline/60">
                {bookings.slice(0, 8).map((b) => {
                  const status = bookingStatusJp(b.status);
                  const customerKind = b.user_id ? '会員' : 'ゲスト';
                  const displayName =
                    b.customers?.full_name ??
                    b.profiles?.full_name ??
                    b.customer_name ??
                    'ゲスト';
                  return (
                    <li key={b.id} className="flex items-center gap-4 px-5 py-3 transition hover:bg-brand-light/30">
                      <div className="w-14 shrink-0 text-center">
                        <div className="font-serif text-[18px] font-bold leading-none text-ink">
                          {formatTime(b.scheduled_at)}
                        </div>
                        <div className="mt-1 text-[10px] text-muted">{b.duration_min ?? 60}分</div>
                      </div>
                      <div className="flex-1">
                        <div className="flex items-center gap-2">
                          <span className="text-[14px] font-semibold text-ink">{displayName}</span>
                          <span
                            className={
                              customerKind === '会員'
                                ? 'rounded-full bg-brand-100 px-1.5 py-0.5 text-[9px] font-bold text-brand-700'
                                : 'rounded-full bg-amber-100 px-1.5 py-0.5 text-[9px] font-bold text-amber-700'
                            }
                          >
                            {customerKind}
                          </span>
                        </div>
                        <div className="mt-0.5 text-[12px] text-ink-soft">
                          {b.menus?.name ?? '(メニュー未設定)'} ・ {b.shops?.name ?? '-'}
                        </div>
                      </div>
                      <div className="text-right">
                        <div className="text-[13px] font-semibold text-ink">{formatYen(b.amount)}</div>
                        <span
                          className={`mt-1 inline-block rounded-full px-2 py-0.5 text-[10px] font-bold ${status.cls}`}
                        >
                          {status.label}
                        </span>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </CardBody>
        </Card>

        {/* クイックアクション */}
        <div className="flex flex-col gap-5">
          <Card>
            <CardHeader title="クイックアクション" subtitle="よく使う操作" />
            <CardBody>
              <div className="grid grid-cols-2 gap-3">
                <QuickAction icon={<CalendarRange className="h-4 w-4" />} label="新規予約" hint="顧客 + メニュー" onClick={() => onNavigate('bookings')} />
                <QuickAction icon={<CalendarClock className="h-4 w-4" />} label="シフト登録" hint="今週分を編集" onClick={() => onNavigate('shifts')} />
                <QuickAction icon={<Users className="h-4 w-4" />} label="スタッフ追加" hint="新メンバー" onClick={() => onNavigate('staff')} />
                <QuickAction icon={<Newspaper className="h-4 w-4" />} label="ブログ投稿" hint="記事を書く" onClick={() => onNavigate('blog')} />
              </div>
            </CardBody>
          </Card>

          <Card>
            <CardHeader title="サロンボード連携" subtitle="同期準備中" />
            <CardBody className="space-y-3">
              <div className="flex items-center justify-between rounded-[12px] bg-amber-50 px-3 py-2">
                <div className="flex items-center gap-2 text-[12px] font-semibold text-amber-700">
                  <span className="inline-block h-2 w-2 rounded-full bg-amber-500" />
                  未接続
                </div>
                <span className="text-[11px] text-amber-700">設定からログイン情報を保存してください</span>
              </div>
              <button
                type="button"
                onClick={() => onNavigate('settings')}
                className="inline-flex w-full items-center justify-center gap-2 rounded-[12px] bg-brand-gradient py-2.5 text-[13px] font-semibold text-white shadow-brand-sm transition hover:shadow-brand"
              >
                サロンボードを設定する
              </button>
            </CardBody>
          </Card>
        </div>
      </section>
    </div>
  );
}

function Stat({
  icon,
  label,
  value,
  loading,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  loading?: boolean;
}) {
  return (
    <div className="rounded-card border border-hairline/60 bg-white/90 p-4 shadow-soft">
      <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-ink-soft">
        <span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-brand-100 text-brand-700">{icon}</span>
        {label}
      </div>
      <div className="mt-2 flex items-baseline gap-2">
        <span className="font-serif text-[24px] font-bold leading-none text-ink">
          {loading ? <Loader2 className="h-4 w-4 animate-spin text-muted" /> : value}
        </span>
      </div>
    </div>
  );
}

function QuickAction({
  icon,
  label,
  hint,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  hint: string;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="group flex flex-col items-start gap-1 rounded-[12px] border border-hairline/60 bg-white/80 p-3 text-left transition hover:border-brand-200 hover:bg-brand-light/40"
    >
      <span className="inline-flex h-7 w-7 items-center justify-center rounded-[8px] bg-brand-light text-brand-700 group-hover:bg-brand-200">
        {icon}
      </span>
      <span className="text-[13px] font-semibold text-ink">{label}</span>
      <span className="text-[10px] text-muted">{hint}</span>
    </button>
  );
}
