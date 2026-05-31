import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Plus, ChevronLeft, ChevronRight, Search, Filter, Loader2, X, CheckCircle2, AlertTriangle, UploadCloud } from 'lucide-react';
import { Card } from '../components/Card';
import { useEffectiveScope } from '../lib/selection-context';
import { fetchRecentBookings, fetchStaffList, fetchMenuList, type BookingRow, type StaffRow, type MenuRow } from '../lib/data';
import { bookingStatusJp, formatTime, formatYen } from '../lib/format';
import { createBookingViaDevice } from '../lib/salonboard';

const FILTERS = ['すべて', 'confirmed', 'pending', 'completed', 'cancelled'] as const;
const FILTER_LABELS: Record<(typeof FILTERS)[number], string> = {
  すべて: 'すべて',
  confirmed: '確定',
  pending: '仮押え',
  completed: '完了',
  cancelled: 'キャンセル',
};

// 出所 / SalonBoard 同期での絞り込み
const SOURCE_FILTERS = ['すべて', 'salonboard', 'synced', 'not_synced'] as const;
type SourceFilter = (typeof SOURCE_FILTERS)[number];
const SOURCE_FILTER_LABELS: Record<SourceFilter, string> = {
  すべて: 'すべて',
  salonboard: 'SalonBoard取得',
  synced: 'SB同期済み',
  not_synced: 'KIREIDOTのみ(未登録)',
};

type SbBadge = {
  /** 絞り込み用の分類キー */
  kind: 'salonboard' | 'synced' | 'pending' | 'failed' | 'not_synced' | 'na';
  label: string;
  cls: string;
  /** SalonBoard に存在することが確実か (✓ 表示用) */
  inSalonboard: boolean;
};

/**
 * 予約の「出所」と「SalonBoard 同期状態」を1つのバッジに分類する。
 *   - source='salonboard' : SalonBoard から取得した予約 (= SB に存在確定)
 *   - source='kireidot' :
 *       synced            : KIREIDOT で作成し SB へ登録済み (SB に存在確定)
 *       pending_push/pushing : 同期待ち / 同期中
 *       failed/manual_required : 登録失敗 / 手動対応必要 (SB 未登録)
 *       それ以外 (null 等) : KIREIDOT のみ (SB 未登録)
 */
function classifySbSync(b: BookingRow): SbBadge {
  const src = b.source ?? null;
  const st = b.salonboard_sync_status ?? null;
  if (src === 'salonboard') {
    return { kind: 'salonboard', label: 'SalonBoard取得', cls: 'bg-sky-100 text-sky-700', inSalonboard: true };
  }
  // ここから source = kireidot (または不明) の KIREIDOT 作成予約
  if (st === 'synced' || st === 'cancelled_synced') {
    return { kind: 'synced', label: 'SB同期済み', cls: 'bg-emerald-100 text-emerald-700', inSalonboard: true };
  }
  if (st === 'pending_push' || st === 'pushing' || st === 'pending_cancel') {
    return { kind: 'pending', label: '同期待ち', cls: 'bg-amber-100 text-amber-700', inSalonboard: false };
  }
  if (st === 'failed') {
    return { kind: 'failed', label: 'SB登録失敗', cls: 'bg-red-100 text-red-700', inSalonboard: false };
  }
  if (st === 'manual_required') {
    return { kind: 'failed', label: '要手動対応', cls: 'bg-red-100 text-red-700', inSalonboard: false };
  }
  // KIREIDOT で作られたが SB へ未送信
  return { kind: 'not_synced', label: 'KIREIDOTのみ', cls: 'bg-rose-100 text-rose-700', inSalonboard: false };
}

export function Bookings() {
  const scope = useEffectiveScope();
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>('すべて');
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>('すべて');
  const [loading, setLoading] = useState(true);
  const [bookings, setBookings] = useState<BookingRow[]>([]);
  const [search, setSearch] = useState('');
  const [modalOpen, setModalOpen] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  // --- 行ごと「サロンボードに挿入」 ---
  const [staffOptions, setStaffOptions] = useState<StaffRow[]>([]);
  const [insertingId, setInsertingId] = useState<string | null>(null);
  // bookingId -> { ok, msg }
  const [insertResults, setInsertResults] = useState<Record<string, { ok: boolean; msg: string }>>({});
  // スタッフ未紐付けの予約をどのスタッフで入れるか選ばせる対象 booking
  const [staffPickFor, setStaffPickFor] = useState<BookingRow | null>(null);

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
    // スタッフ候補 (external_id 付き) も取得しておく
    fetchStaffList(scope)
      .then((rows) => !cancelled && setStaffOptions(rows.filter((s) => !!s.external_id)))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [scope?.shopId, scope?.organizationId, reloadKey]);

  // worker からの単発書き込み結果 (push:test) を購読し、対象行に反映する
  useEffect(() => {
    const bridge = typeof window !== 'undefined' ? window.kireidotApp : undefined;
    if (!bridge?.onWorkerEvent) return;
    return bridge.onWorkerEvent((msg) => {
      if (msg.type !== 'push:test') return;
      const p = msg.payload;
      if (p.step !== 'done') return;
      setInsertingId((cur) => {
        const target = cur;
        if (target) {
          setInsertResults((r) => ({
            ...r,
            [target]: {
              ok: !!p.ok,
              msg: p.ok
                ? (p.registered ? `✅ SalonBoardに登録しました${p.externalId ? ` (ID: ${p.externalId})` : ''}` : '入力のみ完了 (実登録OFF)')
                : `失敗: ${p.error || p.errorCode || 'unknown'}`,
            },
          }));
          if (p.ok && p.registered) {
            // 成功したら少し後に一覧を更新 (sync状態反映)
            setTimeout(() => setReloadKey((k) => k + 1), 2000);
          }
        }
        return null;
      });
    });
  }, []);

  // 実際に1件 SalonBoard へ挿入する。staffExt が無ければスタッフ選択モーダルを出す。
  function insertToSalonboard(b: BookingRow, staffExtOverride?: string, staffNameOverride?: string) {
    const bridge = typeof window !== 'undefined' ? window.kireidotApp : undefined;
    if (!bridge?.workerTestPush || !scope?.shopId) return;
    const staffExt = staffExtOverride || b.salonboard_staff_external_id || '';
    if (!staffExt) {
      // スタッフ未紐付け → 選択モーダルを出す
      setStaffPickFor(b);
      return;
    }
    setStaffPickFor(null);
    setInsertingId(b.id);
    setInsertResults((r) => {
      const { [b.id]: _omit, ...rest } = r;
      return rest;
    });
    void bridge.workerTestPush({
      shopId: scope.shopId,
      staffExternalId: staffExt,
      staffName: staffNameOverride || b.salonboard_staff_name || null,
      menuName: '', // メニューは入れない (時間と内容のみ)
      scheduledAt: b.scheduled_at,
      durationMin: b.duration_min ?? 60,
      customerName: displayName(b) === 'ゲスト' ? null : displayName(b),
      enablePush: true, // 行から挿入 = 実登録
    });
    // 安全網: 90秒で in-flight 解除
    setTimeout(() => setInsertingId((cur) => (cur === b.id ? null : cur)), 90_000);
  }

  const displayName = (b: BookingRow) =>
    b.customers?.full_name ??
    b.profiles?.full_name ??
    b.customer_name ??
    'ゲスト';

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return bookings.filter((b) => {
      if (filter !== 'すべて' && b.status !== filter) return false;
      if (sourceFilter !== 'すべて') {
        const badge = classifySbSync(b);
        if (sourceFilter === 'salonboard' && badge.kind !== 'salonboard') return false;
        if (sourceFilter === 'synced' && !badge.inSalonboard) return false;
        // 「KIREIDOTのみ(未登録)」= SB に存在しない KIREIDOT 作成予約 (未同期/失敗/手動)
        if (sourceFilter === 'not_synced' && (badge.kind === 'salonboard' || badge.inSalonboard))
          return false;
      }
      if (q) {
        const name = displayName(b).toLowerCase();
        const menu = (b.menus?.name ?? '').toLowerCase();
        if (!name.includes(q) && !menu.includes(q)) return false;
      }
      return true;
    });
  }, [bookings, filter, sourceFilter, search]);

  // 集計 (出所フィルタのチップに件数を出す)
  const counts = useMemo(() => {
    let salonboard = 0;
    let synced = 0;
    let notSynced = 0;
    for (const b of bookings) {
      const badge = classifySbSync(b);
      if (badge.kind === 'salonboard') salonboard++;
      if (badge.inSalonboard) synced++;
      if (badge.kind !== 'salonboard' && !badge.inSalonboard) notSynced++;
    }
    return { all: bookings.length, salonboard, synced, notSynced };
  }, [bookings]);

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
          <button
            type="button"
            onClick={() => setModalOpen(true)}
            disabled={!scope?.shopId}
            title={scope?.shopId ? '新規予約を作成して SalonBoard にも登録する' : '先に店舗を選択してください'}
            className="inline-flex h-9 items-center gap-1.5 rounded-[12px] bg-brand-gradient px-4 text-[13px] font-semibold text-white shadow-brand-sm transition hover:shadow-brand disabled:opacity-50"
          >
            <Plus className="h-3.5 w-3.5" /> 新規予約 → SalonBoard登録
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

      {/* 出所 / SalonBoard 同期での絞り込み */}
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-[11px] font-semibold text-muted">SalonBoard:</span>
        {SOURCE_FILTERS.map((f) => {
          const n =
            f === 'すべて'
              ? counts.all
              : f === 'salonboard'
                ? counts.salonboard
                : f === 'synced'
                  ? counts.synced
                  : counts.notSynced;
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
              {SOURCE_FILTER_LABELS[f]}
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
                <th className="px-3 py-3">SalonBoard</th>
                <th className="px-3 py-3 text-right">金額</th>
                <th className="px-3 py-3">状態</th>
                <th className="px-3 py-3">操作</th>
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
                    <td className="px-3 py-3">
                      {(() => {
                        const badge = classifySbSync(b);
                        return (
                          <span className="inline-flex items-center gap-1">
                            <span className={`inline-flex items-center gap-0.5 rounded-full px-2 py-0.5 text-[10px] font-bold ${badge.cls}`}>
                              {badge.inSalonboard && <CheckCircle2 className="h-3 w-3" />}
                              {badge.label}
                            </span>
                            {b.salonboard_detail_url && (
                              <a
                                href={b.salonboard_detail_url}
                                target="_blank"
                                rel="noreferrer"
                                title="SalonBoard で予約詳細を開く"
                                className="text-[10px] text-sky-600 underline hover:text-sky-800"
                              >
                                開く
                              </a>
                            )}
                          </span>
                        );
                      })()}
                    </td>
                    <td className="px-3 py-3 text-right font-semibold text-ink">{formatYen(b.amount)}</td>
                    <td className="px-3 py-3">
                      <span className={`inline-block rounded-full px-2 py-0.5 text-[10px] font-bold ${status.cls}`}>{status.label}</span>
                    </td>
                    <td className="px-3 py-3">
                      {(() => {
                        const badge = classifySbSync(b);
                        const res = insertResults[b.id];
                        // SalonBoard 取得 / 同期済みは挿入不要
                        if (badge.kind === 'salonboard' || badge.inSalonboard) {
                          return <span className="text-[10px] text-muted">—</span>;
                        }
                        if (res) {
                          return (
                            <span className={`text-[10px] font-semibold ${res.ok ? 'text-emerald-700' : 'text-red-600'}`}>
                              {res.msg}
                              {!res.ok && (
                                <button
                                  type="button"
                                  onClick={() => insertToSalonboard(b)}
                                  className="ml-1 underline hover:no-underline"
                                >
                                  再挿入
                                </button>
                              )}
                            </span>
                          );
                        }
                        return (
                          <button
                            type="button"
                            onClick={() => insertToSalonboard(b)}
                            disabled={insertingId === b.id || (!!insertingId && insertingId !== b.id)}
                            title="この予約を SalonBoard に登録する"
                            className="inline-flex items-center gap-1 rounded-[8px] bg-brand-gradient px-2.5 py-1 text-[10px] font-semibold text-white shadow-brand-sm disabled:opacity-40"
                          >
                            {insertingId === b.id ? (
                              <Loader2 className="h-3 w-3 animate-spin" />
                            ) : (
                              <UploadCloud className="h-3 w-3" />
                            )}
                            {insertingId === b.id ? '挿入中…' : 'SalonBoardに挿入'}
                          </button>
                        );
                      })()}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Card>

      {modalOpen && scope?.shopId && (
        <NewBookingModal
          shopId={scope.shopId}
          onClose={() => setModalOpen(false)}
          onCreated={() => {
            setModalOpen(false);
            setReloadKey((k) => k + 1);
          }}
        />
      )}

      {/* スタッフ未紐付け予約の挿入時: SalonBoard スタッフを選ばせる */}
      {staffPickFor && (
        <StaffPickModal
          booking={staffPickFor}
          staff={staffOptions}
          onClose={() => setStaffPickFor(null)}
          onPick={(ext, name) => insertToSalonboard(staffPickFor, ext, name)}
        />
      )}
    </div>
  );
}

// 担当スタッフが SalonBoard と紐付いていない予約を挿入するとき、
// その店舗の SalonBoard スタッフから 1 人選ばせる小モーダル。
function StaffPickModal({
  booking,
  staff,
  onClose,
  onPick,
}: {
  booking: BookingRow;
  staff: StaffRow[];
  onClose: () => void;
  onPick: (ext: string, name: string) => void;
}) {
  const [sel, setSel] = useState(staff[0]?.external_id ?? '');
  const when = new Date(booking.scheduled_at);
  const dt = `${when.toLocaleDateString('ja-JP', { month: 'numeric', day: 'numeric' })} ${when.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })}`;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/30 p-4 backdrop-blur-sm" onClick={onClose}>
      <div className="w-full max-w-md rounded-[18px] border border-hairline bg-white shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-hairline/70 px-5 py-4">
          <h2 className="font-serif text-[16px] font-bold text-ink">SalonBoard に挿入 — 担当スタッフを選択</h2>
          <button type="button" onClick={onClose} className="inline-flex h-8 w-8 items-center justify-center rounded-full text-ink-soft hover:bg-brand-light/50">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="px-5 py-4">
          <p className="mb-3 text-[12px] text-ink-soft">
            {dt}・{booking.duration_min ?? 60}分 の予約を SalonBoard に登録します。<br />
            この予約はスタッフが SalonBoard と紐付いていないため、登録先スタッフを選んでください。
          </p>
          {staff.length === 0 ? (
            <p className="rounded-[10px] bg-amber-50 px-3 py-2 text-[12px] text-amber-800">
              external_id 付きスタッフが見つかりません。先に「スタッフ」を同期してください。
            </p>
          ) : (
            <select
              value={sel}
              onChange={(e) => setSel(e.target.value)}
              className="h-10 w-full rounded-[10px] border border-hairline bg-white px-3 text-[13px] focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/20"
            >
              {staff.map((s) => (
                <option key={s.id} value={s.external_id ?? ''}>
                  {s.full_name}（{s.external_id}）
                </option>
              ))}
            </select>
          )}
          <div className="mt-4 flex items-center justify-end gap-2">
            <button type="button" onClick={onClose} className="inline-flex h-10 items-center rounded-[12px] border border-hairline bg-white px-4 text-[13px] font-semibold text-ink-soft hover:bg-brand-light/40">
              キャンセル
            </button>
            <button
              type="button"
              disabled={!sel}
              onClick={() => {
                const s = staff.find((x) => x.external_id === sel);
                onPick(sel, s?.full_name ?? '');
              }}
              className="inline-flex h-10 items-center gap-1.5 rounded-[12px] bg-brand-gradient px-5 text-[13px] font-semibold text-white shadow-brand-sm disabled:opacity-50"
            >
              <UploadCloud className="h-3.5 w-3.5" /> このスタッフで挿入
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// =====================================================================
// 新規予約モーダル
//
// 日付・担当スタッフ (SalonBoard external_id) ・メニュー名・時刻・所要・顧客名を
// 入力して予約を作成し、SalonBoard への push_booking ジョブまで積む。
// 成功・失敗・原因をモーダル内にすべて表示する。
// =====================================================================
type SubmitState =
  | { kind: 'idle' }
  | { kind: 'submitting' }
  | { kind: 'success'; bookingId: string; syncStatus: 'pending_push' | 'not_enqueued' }
  | { kind: 'error'; message: string; status?: number };

function todayStr(): string {
  const d = new Date();
  const jst = new Date(d.getTime() + 9 * 3600_000);
  return jst.toISOString().slice(0, 10);
}

function NewBookingModal({
  shopId,
  onClose,
  onCreated,
}: {
  shopId: string;
  onClose: () => void;
  onCreated: () => void;
}) {
  const scope = useEffectiveScope();
  const [staffLoading, setStaffLoading] = useState(true);
  const [staff, setStaff] = useState<StaffRow[]>([]);
  const [menus, setMenus] = useState<MenuRow[]>([]);
  const [menuLoading, setMenuLoading] = useState(true);
  const [date, setDate] = useState(todayStr());
  const [time, setTime] = useState('10:00');
  const [duration, setDuration] = useState('60');
  const [staffExternalId, setStaffExternalId] = useState('');
  const [menuName, setMenuName] = useState('');
  const [customerName, setCustomerName] = useState('');
  const [notes, setNotes] = useState('');
  const [state, setState] = useState<SubmitState>({ kind: 'idle' });

  // スタッフ一覧 (salonboard_staff_imports。external_id を持つもののみ選択肢に)
  useEffect(() => {
    if (!scope) return;
    let cancelled = false;
    setStaffLoading(true);
    fetchStaffList(scope)
      .then((rows) => {
        if (cancelled) return;
        const withExt = rows.filter((r) => !!r.external_id);
        setStaff(withExt);
        if (withExt.length > 0 && !staffExternalId) {
          setStaffExternalId(withExt[0].external_id ?? '');
        }
      })
      .finally(() => !cancelled && setStaffLoading(false));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope?.shopId]);

  // メニュー一覧 (salonboard_menu_imports。メニュー同期で投入される)
  useEffect(() => {
    if (!scope) return;
    let cancelled = false;
    setMenuLoading(true);
    fetchMenuList(scope)
      .then((rows) => {
        if (cancelled) return;
        setMenus(rows);
        if (rows.length > 0 && !menuName) setMenuName(rows[0].name);
      })
      .finally(() => !cancelled && setMenuLoading(false));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope?.shopId]);

  const selectedStaff = useMemo(
    () => staff.find((s) => s.external_id === staffExternalId) ?? null,
    [staff, staffExternalId],
  );
  const selectedMenu = useMemo(
    () => menus.find((m) => m.name === menuName) ?? null,
    [menus, menuName],
  );

  const canSubmit =
    !!date &&
    /^\d{1,2}:\d{2}$/.test(time) &&
    !!staffExternalId &&
    !!menuName.trim() &&
    state.kind !== 'submitting';

  async function handleSubmit() {
    if (!canSubmit) return;
    setState({ kind: 'submitting' });
    // JST オフセット付き ISO を組み立てる
    const scheduledAt = `${date}T${time.length === 4 ? '0' + time : time}:00+09:00`;
    const durationMin = Number(duration) > 0 ? Number(duration) : 60;
    const res = await createBookingViaDevice({
      shopId,
      scheduledAt,
      staffExternalId,
      staffName: selectedStaff?.full_name ?? null,
      menuName: menuName.trim(),
      durationMin,
      customerName: customerName.trim() || null,
      notes: notes.trim() || null,
    });
    if (res.ok) {
      setState({ kind: 'success', bookingId: res.bookingId, syncStatus: res.syncStatus });
    } else {
      setState({ kind: 'error', message: res.error, status: res.status });
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/30 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg overflow-hidden rounded-[18px] border border-hairline bg-white shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-hairline/70 px-5 py-4">
          <h2 className="font-serif text-[17px] font-bold text-ink">新規予約 (SalonBoard 書き込み)</h2>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-8 w-8 items-center justify-center rounded-full text-ink-soft hover:bg-brand-light/50"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="max-h-[70vh] overflow-y-auto px-5 py-4">
          {state.kind === 'success' ? (
            <div className="flex flex-col gap-3 py-6 text-center">
              <CheckCircle2 className="mx-auto h-10 w-10 text-emerald-500" />
              <div className="font-serif text-[16px] font-bold text-ink">予約を作成しました</div>
              <div className="text-[13px] text-ink-soft">
                予約ID: <code className="rounded bg-brand-light/50 px-1.5 py-0.5 text-[12px]">{state.bookingId}</code>
              </div>
              {state.syncStatus === 'pending_push' ? (
                <div className="rounded-[12px] bg-emerald-50 px-4 py-3 text-[12px] text-emerald-700">
                  SalonBoard への書き込みジョブを投入しました (同期待ち)。<br />
                  予約同期くんが SalonBoard に登録します。状態は予約一覧で確認できます。
                </div>
              ) : (
                <div className="rounded-[12px] bg-amber-50 px-4 py-3 text-left text-[12px] text-amber-800">
                  <div className="font-semibold">⚠️ 書き込みジョブは投入されませんでした</div>
                  <div className="mt-1">
                    この店舗の SalonBoard 連携が無効、またはブロック中の可能性があります。<br />
                    「サロンボード連携」画面で連携状態を確認してください。予約自体は作成済みです。
                  </div>
                </div>
              )}
              <button
                type="button"
                onClick={onCreated}
                className="mx-auto mt-2 inline-flex h-10 items-center rounded-[12px] bg-brand-gradient px-6 text-[13px] font-semibold text-white shadow-brand-sm"
              >
                閉じて一覧を更新
              </button>
            </div>
          ) : (
            <div className="flex flex-col gap-4">
              <div className="grid grid-cols-2 gap-3">
                <Field label="日付">
                  <input
                    type="date"
                    value={date}
                    onChange={(e) => setDate(e.target.value)}
                    className={inputCls}
                  />
                </Field>
                <Field label="開始時刻">
                  <input
                    type="time"
                    value={time}
                    onChange={(e) => setTime(e.target.value)}
                    className={inputCls}
                  />
                </Field>
              </div>

              <Field label="担当スタッフ (SalonBoard)">
                {staffLoading ? (
                  <div className="flex items-center gap-2 text-[12px] text-ink-soft">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" /> スタッフ読み込み中…
                  </div>
                ) : staff.length === 0 ? (
                  <div className="rounded-[10px] bg-amber-50 px-3 py-2 text-[12px] text-amber-800">
                    external_id を持つスタッフが見つかりません。先に「スタッフ」同期を実行してください。
                  </div>
                ) : (
                  <select
                    value={staffExternalId}
                    onChange={(e) => setStaffExternalId(e.target.value)}
                    className={inputCls}
                  >
                    {staff.map((s) => (
                      <option key={s.id} value={s.external_id ?? ''}>
                        {s.full_name}（{s.external_id}）
                      </option>
                    ))}
                  </select>
                )}
              </Field>

              <Field label="メニュー (SalonBoard)">
                {menuLoading ? (
                  <div className="flex items-center gap-2 text-[12px] text-ink-soft">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" /> メニュー読み込み中…
                  </div>
                ) : menus.length > 0 ? (
                  <>
                    <select
                      value={menuName}
                      onChange={(e) => {
                        setMenuName(e.target.value);
                        // メニュー選択で所要時間を自動補完 (空でなければ尊重)
                        const m = menus.find((x) => x.name === e.target.value);
                        if (m?.duration_min) setDuration(String(m.duration_min));
                      }}
                      className={inputCls}
                    >
                      {menus.map((m) => (
                        <option key={m.id} value={m.name}>
                          {m.category ? `[${m.category}] ` : ''}{m.name}
                          {m.price ? ` (¥${m.price.toLocaleString()})` : ''}
                        </option>
                      ))}
                    </select>
                    {selectedMenu && (
                      <span className="mt-1 text-[10px] text-muted">
                        {selectedMenu.duration_min ? `${selectedMenu.duration_min}分` : ''}
                        {selectedMenu.price ? ` / ¥${selectedMenu.price.toLocaleString()}` : ''}
                      </span>
                    )}
                  </>
                ) : (
                  <>
                    <input
                      type="text"
                      value={menuName}
                      onChange={(e) => setMenuName(e.target.value)}
                      placeholder="例: カット (SalonBoard 上の表示名と一致させる)"
                      className={inputCls}
                    />
                    <span className="mt-1 text-[10px] text-amber-700">
                      メニュー未同期です。「メニュー」を同期すると一覧から選べます (今は手入力)。
                    </span>
                  </>
                )}
              </Field>

              <div className="grid grid-cols-2 gap-3">
                <Field label="所要時間 (分)">
                  <input
                    type="number"
                    min={5}
                    step={5}
                    value={duration}
                    onChange={(e) => setDuration(e.target.value)}
                    className={inputCls}
                  />
                </Field>
                <Field label="顧客名 (任意)">
                  <input
                    type="text"
                    value={customerName}
                    onChange={(e) => setCustomerName(e.target.value)}
                    placeholder="例: テスト 太郎"
                    className={inputCls}
                  />
                </Field>
              </div>

              <Field label="備考 (任意)">
                <textarea
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  rows={2}
                  className={inputCls}
                />
              </Field>

              {state.kind === 'error' && (
                <div className="flex items-start gap-2 rounded-[12px] bg-red-50 px-4 py-3 text-[12px] text-red-700">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                  <div>
                    <div className="font-semibold">
                      予約の作成に失敗しました{state.status ? ` (HTTP ${state.status})` : ''}
                    </div>
                    <div className="mt-0.5 break-all">{state.message}</div>
                  </div>
                </div>
              )}

              <div className="mt-1 flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={onClose}
                  className="inline-flex h-10 items-center rounded-[12px] border border-hairline bg-white px-4 text-[13px] font-semibold text-ink-soft hover:bg-brand-light/40"
                >
                  キャンセル
                </button>
                <button
                  type="button"
                  onClick={handleSubmit}
                  disabled={!canSubmit}
                  className="inline-flex h-10 items-center gap-1.5 rounded-[12px] bg-brand-gradient px-5 text-[13px] font-semibold text-white shadow-brand-sm disabled:opacity-50"
                >
                  {state.kind === 'submitting' ? (
                    <>
                      <Loader2 className="h-3.5 w-3.5 animate-spin" /> 作成中…
                    </>
                  ) : (
                    <>
                      <Plus className="h-3.5 w-3.5" /> 予約を作成
                    </>
                  )}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

const inputCls =
  'h-10 w-full rounded-[10px] border border-hairline bg-white px-3 text-[13px] focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/20';

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[11px] font-semibold uppercase tracking-wider text-muted">{label}</span>
      {children}
    </label>
  );
}
