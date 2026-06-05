import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Plus, ChevronLeft, ChevronRight, Search, Filter, Loader2, X, CheckCircle2, AlertTriangle, UploadCloud, CalendarDays } from 'lucide-react';
import { Card } from '../components/Card';
import { useEffectiveScope } from '../lib/selection-context';
import { fetchRecentBookings, fetchUnmatchedBookings, fetchStaffList, fetchMenuList, cancelBookingLocal, updateBookingTimeLocal, type BookingRow, type StaffRow, type MenuRow } from '../lib/data';
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
  kind: 'salonboard' | 'synced' | 'synced_noid' | 'pending' | 'failed' | 'not_synced' | 'na';
  label: string;
  cls: string;
  /** SalonBoard に存在することが確実か (✓ 表示用) */
  inSalonboard: boolean;
};

/**
 * 予約の「出所」と「SalonBoard 同期状態」を1つのバッジに分類する。
 *   - source='salonboard' : SalonBoard から取得した予約 (= SB に存在確定)
 *   - source='kireidot' :
 *       synced (ext_id あり)  : KIREIDOT で作成し SB へ登録済み (SB に存在確定)
 *       synced (ext_id 無し)  : SB登録は成功扱いだが reserveId 未取得 → SBに在るか「要確認」
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
    // synced でも SB 予約ID(external_booking_id)が無いものは「登録は成功したが
    // reserveId を取れなかった」ケース。SBに在る可能性が高いが確証が無いので
    // 「要確認」として区別する (誤って再挿入＝二重登録を防ぐ)。
    if (st === 'synced' && !b.external_booking_id) {
      return { kind: 'synced_noid', label: 'SB要確認(ID未取得)', cls: 'bg-amber-100 text-amber-800', inSalonboard: false };
    }
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
  // 「キレイドットだけにあって SalonBoard に未登録」な未来の予約 (期間非依存・別取得)
  const [unmatched, setUnmatched] = useState<BookingRow[]>([]);
  const [search, setSearch] = useState('');
  const [modalOpen, setModalOpen] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  // 表示範囲のオフセット (日数。0=今日起点の30日, +30=次の30日 …)
  const [rangeOffset, setRangeOffset] = useState(0);
  // 右上カレンダーで選んだ「この日を表示」用のターゲット日 (台帳の初期選択日にも使う)
  const [calendarTarget, setCalendarTarget] = useState<string | null>(null);
  const [calendarOpen, setCalendarOpen] = useState(false);
  // 表示ビュー (台帳がデフォルト)
  const [view, setView] = useState<'ledger' | 'list'>('ledger');

  // --- 行ごと「サロンボードに挿入」 ---
  const [staffOptions, setStaffOptions] = useState<StaffRow[]>([]);
  // 挿入中の booking id 集合 (複数同時挿入に対応。worker 側で直列実行される)。
  const [insertingIds, setInsertingIds] = useState<Set<string>>(new Set());
  const isInserting = (id: string) => insertingIds.has(id);
  // bookingId -> { ok, msg }
  const [insertResults, setInsertResults] = useState<Record<string, { ok: boolean; msg: string }>>({});
  // スタッフ未紐付けの予約をどのスタッフで入れるか選ばせる対象 booking
  const [staffPickFor, setStaffPickFor] = useState<BookingRow | null>(null);
  // キャンセル処理中の booking id と結果メッセージ
  const [cancelingId, setCancelingId] = useState<string | null>(null);
  const [cancelResults, setCancelResults] = useState<Record<string, { ok: boolean; msg: string }>>({});
  // 変更処理中の booking id と結果メッセージ
  const [changingId, setChangingId] = useState<string | null>(null);
  const [changeResults, setChangeResults] = useState<Record<string, { ok: boolean; msg: string }>>({});

  useEffect(() => {
    if (!scope) return;
    let cancelled = false;
    setLoading(true);
    // 30 日分を取得 (月単位の表示)
    fetchRecentBookings(scope, 30, rangeOffset)
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
  }, [scope?.shopId, scope?.organizationId, reloadKey, rangeOffset]);

  // 未連携リスト (本日以降・未来分) は表示期間に依存しないので別取得。
  // 予約作成/挿入/キャンセル等で reloadKey が変わったときも更新する。
  useEffect(() => {
    if (!scope) return;
    let cancelled = false;
    fetchUnmatchedBookings(scope)
      .then((data) => !cancelled && setUnmatched(data))
      .catch(() => !cancelled && setUnmatched([]));
    return () => {
      cancelled = true;
    };
  }, [scope?.shopId, scope?.organizationId, reloadKey]);

  // worker からの単発書き込み結果 (push:test) を購読し、対象行に反映する。
  // 複数同時挿入に対応するため、結果はイベントの bookingId で正しい行に紐付ける。
  useEffect(() => {
    const bridge = typeof window !== 'undefined' ? window.kireidotApp : undefined;
    if (!bridge?.onWorkerEvent) return;
    return bridge.onWorkerEvent((msg) => {
      if (msg.type !== 'push:test') return;
      const p = msg.payload;
      if (p.step !== 'done') return;
      // どの予約の結果か。bookingId があればそれ、無ければ挿入中が1件のときのみそれを使う。
      setInsertingIds((cur) => {
        let target = p.bookingId ?? null;
        if (!target && cur.size === 1) target = Array.from(cur)[0];
        if (!target) return cur;
        setInsertResults((r) => ({
          ...r,
          [target as string]: {
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
        const next = new Set(cur);
        next.delete(target);
        return next;
      });
    });
  }, []);

  // worker からのキャンセル結果 (cancel:test) を購読する
  useEffect(() => {
    const bridge = typeof window !== 'undefined' ? window.kireidotApp : undefined;
    if (!bridge?.onWorkerEvent) return;
    return bridge.onWorkerEvent((msg) => {
      if (msg.type !== 'cancel:test') return;
      const p = msg.payload;
      if (p.step !== 'done') return;
      setCancelingId((cur) => {
        const target = cur;
        if (target) {
          setCancelResults((r) => ({
            ...r,
            [target]: {
              ok: !!p.ok,
              msg: p.ok ? (p.msg || '✅ SalonBoardでキャンセルしました') : `失敗: ${p.error || p.errorCode || 'unknown'}`,
            },
          }));
          if (p.ok) setTimeout(() => setReloadKey((k) => k + 1), 2000);
        }
        return null;
      });
    });
  }, []);

  // KIREIDOT + SalonBoard 両方をキャンセルする。
  // SalonBoard 連携済み (external_booking_id あり) なら worker でSB側もキャンセル。
  // 未連携なら KIREIDOT 側だけ cancelled にする。
  function cancelBooking(b: BookingRow) {
    const bridge = typeof window !== 'undefined' ? window.kireidotApp : undefined;
    if (!scope?.shopId) return;
    const hasSb = !!b.external_booking_id;
    const confirmMsg = hasSb
      ? `この予約を KIREIDOT・SalonBoard の両方でキャンセルします。よろしいですか？\n\n${displayName(b)} / ${new Date(b.scheduled_at).toLocaleString('ja-JP')}`
      : `この予約をキャンセルします (SalonBoard 未連携のため KIREIDOT のみ)。よろしいですか？\n\n${displayName(b)} / ${new Date(b.scheduled_at).toLocaleString('ja-JP')}`;
    if (!window.confirm(confirmMsg)) return;

    setCancelingId(b.id);
    setCancelResults((r) => {
      const { [b.id]: _omit, ...rest } = r;
      return rest;
    });
    if (hasSb && bridge?.workerCancelBooking) {
      void bridge.workerCancelBooking({
        shopId: scope.shopId,
        bookingId: b.id,
        externalBookingId: b.external_booking_id as string,
        scheduledAt: b.scheduled_at,
        staffExternalId: resolveStaffExt(b)?.ext ?? null,
        staffName: b.salonboard_staff_name ?? null,
        enableCancel: true,
      });
      // 安全網: 120秒で解除
      setTimeout(() => setCancelingId((cur) => (cur === b.id ? null : cur)), 120_000);
    } else {
      // SalonBoard 未連携 → KIREIDOT 側のみ cancelled に
      void (async () => {
        try {
          const { error } = await cancelBookingLocal(b.id);
          setCancelResults((r) => ({
            ...r,
            [b.id]: error ? { ok: false, msg: `失敗: ${error}` } : { ok: true, msg: 'KIREIDOTでキャンセルしました (SB未連携)' },
          }));
          if (!error) setTimeout(() => setReloadKey((k) => k + 1), 1000);
        } finally {
          setCancelingId((cur) => (cur === b.id ? null : cur));
        }
      })();
    }
  }

  // worker からの変更結果 (change:test) を購読する
  useEffect(() => {
    const bridge = typeof window !== 'undefined' ? window.kireidotApp : undefined;
    if (!bridge?.onWorkerEvent) return;
    return bridge.onWorkerEvent((msg) => {
      if (msg.type !== 'change:test') return;
      const p = msg.payload;
      if (p.step !== 'done') return;
      setChangingId((cur) => {
        const target = cur;
        if (target) {
          setChangeResults((r) => ({
            ...r,
            [target]: { ok: !!p.ok, msg: p.ok ? (p.msg || '✅ SalonBoardで変更しました') : `失敗: ${p.error || p.errorCode || 'unknown'}` },
          }));
          if (p.ok) setTimeout(() => setReloadKey((k) => k + 1), 2000);
        }
        return null;
      });
    });
  }, []);

  // SalonBoard 連携済み予約の時間/所要を変更する。
  // 先に KIREIDOT 側の bookings を更新し、その後 worker で SalonBoard も変更する。
  function changeBooking(b: BookingRow, newIso: string, newDurationMin: number) {
    const bridge = typeof window !== 'undefined' ? window.kireidotApp : undefined;
    if (!scope?.shopId) return;
    const hasSb = !!b.external_booking_id;
    setChangingId(b.id);
    setChangeResults((r) => {
      const { [b.id]: _omit, ...rest } = r;
      return rest;
    });
    void (async () => {
      // 1) KIREIDOT 側を先に更新 (SB連携の有無に関わらず常に実行)
      const { error } = await updateBookingTimeLocal(b.id, newIso, newDurationMin);
      if (error) {
        setChangeResults((r) => ({ ...r, [b.id]: { ok: false, msg: `KIREIDOT 更新に失敗: ${error}` } }));
        setChangingId((cur) => (cur === b.id ? null : cur));
        return;
      }
      // 2) SalonBoard 連携済み (reserveId あり) なら worker で SB 側も変更
      if (hasSb && bridge?.workerChangeBooking) {
        void bridge.workerChangeBooking({
          shopId: scope.shopId!,
          bookingId: b.id,
          externalBookingId: b.external_booking_id as string,
          scheduledAt: newIso,
          durationMin: newDurationMin,
          staffExternalId: resolveStaffExt(b)?.ext ?? null,
          staffName: b.salonboard_staff_name ?? null,
          enableChange: true,
        });
        setTimeout(() => setChangingId((cur) => (cur === b.id ? null : cur)), 120_000);
      } else {
        // SB 未連携 → KIREIDOT のみ更新で完了
        setChangeResults((r) => ({
          ...r,
          [b.id]: { ok: true, msg: hasSb ? 'KIREIDOT のみ更新しました (Electron 環境ではないため SB 未反映)' : 'KIREIDOT の予約時間を変更しました (SalonBoard 未連携)' },
        }));
        setChangingId((cur) => (cur === b.id ? null : cur));
        setTimeout(() => setReloadKey((k) => k + 1), 1000);
      }
    })();
  }

  // 予約のスタッフ紐付けから SalonBoard external_id を解決する。
  //   ① 予約に直接入っている salonboard_staff_external_id
  //   ② staff_id を salonboard_staff_imports.matched_staff_id で逆引き
  //   ③ SalonBoard 担当名の一致 (前後の (指) を除去して比較)
  function resolveStaffExt(b: BookingRow): { ext: string; name: string | null } | null {
    if (b.salonboard_staff_external_id) {
      return { ext: b.salonboard_staff_external_id, name: b.salonboard_staff_name ?? null };
    }
    if (b.staff_id) {
      const hit = staffOptions.find((s) => s.matched_staff_id && s.matched_staff_id === b.staff_id);
      if (hit?.external_id) return { ext: hit.external_id, name: hit.full_name };
    }
    if (b.salonboard_staff_name) {
      const norm = (s: string) => s.replace(/[（(]指[）)]/g, '').trim().toLowerCase();
      const target = norm(b.salonboard_staff_name);
      const hit = staffOptions.find((s) => norm(s.full_name) === target);
      if (hit?.external_id) return { ext: hit.external_id, name: hit.full_name };
    }
    return null;
  }

  // 実際に1件 SalonBoard へ挿入する。staffExt が解決できなければスタッフ選択モーダルを出す。
  function insertToSalonboard(b: BookingRow, staffExtOverride?: string, staffNameOverride?: string) {
    const bridge = typeof window !== 'undefined' ? window.kireidotApp : undefined;
    if (!bridge?.workerTestPush || !scope?.shopId) return;
    const resolved = staffExtOverride
      ? { ext: staffExtOverride, name: staffNameOverride ?? null }
      : resolveStaffExt(b);
    if (!resolved?.ext) {
      // どうしても解決できないときだけ選択モーダルを出す
      setStaffPickFor(b);
      return;
    }
    const staffExt = resolved.ext;
    setStaffPickFor(null);
    setInsertingIds((cur) => new Set(cur).add(b.id));
    setInsertResults((r) => {
      const { [b.id]: _omit, ...rest } = r;
      return rest;
    });
    void bridge.workerTestPush({
      shopId: scope.shopId,
      staffExternalId: staffExt,
      staffName: staffNameOverride || resolved.name || b.salonboard_staff_name || null,
      menuName: '', // メニューは入れない (時間と内容のみ)
      scheduledAt: b.scheduled_at,
      durationMin: b.duration_min ?? 60,
      customerName: displayName(b) === 'ゲスト' ? null : displayName(b),
      enablePush: true, // 行から挿入 = 実登録
      bookingId: b.id, // 成功時に DB の同期状態を synced に更新する
    });
    // 安全網: 90秒で in-flight 解除
    setTimeout(
      () =>
        setInsertingIds((cur) => {
          if (!cur.has(b.id)) return cur;
          const next = new Set(cur);
          next.delete(b.id);
          return next;
        }),
      90_000,
    );
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

  // 表示範囲の開始日 (今日 + rangeOffset 日) と終了日 (30日後)
  const rangeStart = (() => {
    const d = new Date();
    d.setDate(d.getDate() + rangeOffset);
    d.setHours(0, 0, 0, 0);
    return d;
  })();
  const rangeEnd = (() => {
    const d = new Date(rangeStart);
    d.setDate(d.getDate() + 29);
    return d;
  })();
  const rangeLabel =
    rangeOffset === 0 ? '今日から' : rangeOffset > 0 ? `${rangeOffset} 日後から` : `${-rangeOffset} 日前から`;

  // 右上カレンダーで日付を選んだら、その日を含む範囲に移動し、台帳の選択日にする
  const jumpToDate = (d: Date) => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const target = new Date(d);
    target.setHours(0, 0, 0, 0);
    const diffDays = Math.round((target.getTime() - today.getTime()) / 86_400_000);
    setRangeOffset(diffDays);
    setCalendarTarget(ymd(target));
    setCalendarOpen(false);
  };

  return (
    <div className="flex flex-col gap-5 pt-4">
      <div className="flex flex-col items-stretch gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setRangeOffset((w) => w - 30)}
            title="前の30日間"
            className="inline-flex h-9 w-9 items-center justify-center rounded-full border border-hairline bg-white/80 text-ink-soft hover:bg-brand-light/50"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={() => { setRangeOffset(0); setCalendarTarget(ymd(new Date())); }}
            title="今日を含む期間に戻る"
            className="rounded-[12px] border border-hairline bg-white/85 px-4 py-2 text-left hover:bg-brand-light/30"
          >
            <div className="text-[10px] uppercase tracking-wider text-muted">{rangeLabel} 30 日</div>
            <div className="font-serif text-[16px] font-bold text-ink">
              {rangeStart.toLocaleDateString('ja-JP', { month: 'long', day: 'numeric' })}
              {' 〜 '}
              {rangeEnd.toLocaleDateString('ja-JP', { month: 'long', day: 'numeric' })}
            </div>
          </button>
          <button
            type="button"
            onClick={() => setRangeOffset((w) => w + 30)}
            title="次の30日間"
            className="inline-flex h-9 w-9 items-center justify-center rounded-full border border-hairline bg-white/80 text-ink-soft hover:bg-brand-light/50"
          >
            <ChevronRight className="h-4 w-4" />
          </button>
          {/* 右上カレンダー (Admin 風) で日付ジャンプ */}
          <div className="relative">
            <button
              type="button"
              onClick={() => setCalendarOpen((o) => !o)}
              title="カレンダーから日付を選ぶ"
              className="inline-flex h-9 w-9 items-center justify-center rounded-full border border-hairline bg-white/80 text-ink-soft hover:bg-brand-light/50"
            >
              <CalendarDays className="h-4 w-4" />
            </button>
            {calendarOpen && (
              <MiniCalendar
                selected={calendarTarget}
                onPick={jumpToDate}
                onClose={() => setCalendarOpen(false)}
              />
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          {/* ビュー切替 (台帳 / リスト) */}
          <div className="inline-flex overflow-hidden rounded-[12px] border border-hairline bg-white/80">
            <button
              type="button"
              onClick={() => setView('ledger')}
              className={
                'h-9 px-3 text-[12px] font-semibold ' +
                (view === 'ledger' ? 'bg-brand-gradient text-white' : 'text-ink-soft hover:bg-brand-light/40')
              }
            >
              台帳
            </button>
            <button
              type="button"
              onClick={() => setView('list')}
              className={
                'h-9 px-3 text-[12px] font-semibold ' +
                (view === 'list' ? 'bg-brand-gradient text-white' : 'text-ink-soft hover:bg-brand-light/40')
              }
            >
              リスト
            </button>
          </div>
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

      {view === 'ledger' && (
        <LedgerView
          bookings={filtered}
          staff={staffOptions}
          loading={loading}
          targetDay={calendarTarget}
          displayName={displayName}
          classify={classifySbSync}
          isInserting={isInserting}
          insertResults={insertResults}
          onInsert={insertToSalonboard}
          cancelingId={cancelingId}
          cancelResults={cancelResults}
          onCancel={cancelBooking}
          changingId={changingId}
          changeResults={changeResults}
          onChange={changeBooking}
        />
      )}

      {view === 'list' && (
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
                            disabled={isInserting(b.id)}
                            title="この予約を SalonBoard に登録する"
                            className="inline-flex items-center gap-1 rounded-[8px] bg-brand-gradient px-2.5 py-1 text-[10px] font-semibold text-white shadow-brand-sm disabled:opacity-40"
                          >
                            {isInserting(b.id) ? (
                              <Loader2 className="h-3 w-3 animate-spin" />
                            ) : (
                              <UploadCloud className="h-3 w-3" />
                            )}
                            {isInserting(b.id) ? '挿入中…' : 'SalonBoardに挿入'}
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
      )}

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

      {/* ── キレイドットだけにあって SalonBoard に追加できていない予約 ──
          表示中の 30 日間に関係なく、本日以降・キャンセル以外・未連携の予約を
          別取得 (fetchUnmatchedBookings) してページ最下部に常に表示する。 */}
      <Card>
        <div className="flex items-center gap-2 border-b border-rose-200 bg-rose-50 px-4 py-3">
          <span className="inline-block h-2 w-2 rounded-full bg-rose-500" />
          <h2 className="text-[13px] font-bold text-rose-900">
            キレイドットだけにあって SalonBoard に追加できていない予約
          </h2>
          <span className="ml-1 rounded-full bg-rose-100 px-2 py-0.5 text-[11px] font-semibold text-rose-700">
            {unmatched.length}件
          </span>
          <span className="ml-auto text-[11px] text-muted">本日以降・キャンセル除外（要確認含む）</span>
        </div>
        {!scope?.shopId && !scope?.organizationId ? (
          <div className="px-4 py-10 text-center text-[12px] text-ink-soft">
            右上で会社・店舗を選択すると、その範囲の未登録予約が表示されます。
          </div>
        ) : unmatched.length === 0 ? (
          <div className="px-4 py-10 text-center text-[12px] text-ink-soft">
            SalonBoard に未登録の予約はありません。
          </div>
        ) : (
          <table className="w-full text-[12px]">
            <thead className="bg-surface-soft text-[10px] uppercase tracking-wider text-muted">
              <tr>
                <th className="px-4 py-2.5 text-left">日時</th>
                <th className="px-4 py-2.5 text-left">顧客</th>
                <th className="px-4 py-2.5 text-left">スタッフ</th>
                <th className="px-4 py-2.5 text-left">メニュー</th>
                {!scope?.shopId && <th className="px-4 py-2.5 text-left">店舗</th>}
                <th className="px-4 py-2.5 text-left">状態</th>
                <th className="px-4 py-2.5 text-right">操作</th>
              </tr>
            </thead>
            <tbody>
              {unmatched.map((b) => {
                const badge = classifySbSync(b);
                const dt = new Date(b.scheduled_at);
                const staffName =
                  b.staff?.full_name ?? b.salonboard_staff_name ?? '未割当';
                const menuName = b.menus?.name ?? '—';
                const res = insertResults[b.id];
                return (
                  <tr key={b.id} className="border-t border-hairline hover:bg-rose-50/40">
                    <td className="whitespace-nowrap px-4 py-2.5 text-ink">
                      {dt.toLocaleString('ja-JP', {
                        month: 'numeric',
                        day: 'numeric',
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </td>
                    <td className="px-4 py-2.5">{displayName(b)}</td>
                    <td className="px-4 py-2.5 text-ink-soft">{staffName}</td>
                    <td className="px-4 py-2.5 text-ink-soft">{menuName}</td>
                    {!scope?.shopId && (
                      <td className="px-4 py-2.5 text-ink-soft">{b.shops?.name ?? '—'}</td>
                    )}
                    <td className="px-4 py-2.5">
                      <span
                        className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold ${badge.cls}`}
                      >
                        {badge.label}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-right">
                      {res ? (
                        <span
                          className={
                            'text-[11px] font-semibold ' +
                            (res.ok ? 'text-emerald-700' : 'text-red-700')
                          }
                        >
                          {res.msg}
                        </span>
                      ) : badge.kind === 'synced_noid' ? (
                        // SBに在る可能性が高い「要確認」。誤挿入(二重登録)を防ぐため、
                        // 押す前に SB を確認するよう促し、確認後だけ挿入する。
                        <button
                          type="button"
                          disabled={!scope?.shopId || isInserting(b.id)}
                          onClick={() => {
                            const ok = window.confirm(
                              `この予約は SalonBoard に登録済みの可能性が高いです（登録は成功したが予約IDを取得できなかったケース）。\n\nSalonBoard に「${displayName(b)} / ${dt.toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}」の予約が無いことを確認しましたか？\n\nOK を押すと SalonBoard に登録します（既にある場合は二重登録になります）。`,
                            );
                            if (ok) insertToSalonboard(b);
                          }}
                          title="SalonBoardに無いことを確認してから登録する"
                          className="inline-flex items-center gap-1 rounded-[8px] border border-amber-300 bg-amber-50 px-2.5 py-1 text-[11px] font-semibold text-amber-800 hover:bg-amber-100 disabled:opacity-50"
                        >
                          {isInserting(b.id) ? (
                            <Loader2 className="h-3 w-3 animate-spin" />
                          ) : (
                            <AlertTriangle className="h-3 w-3" />
                          )}
                          {isInserting(b.id) ? '挿入中…' : '確認して挿入'}
                        </button>
                      ) : (
                        <button
                          type="button"
                          disabled={!scope?.shopId || isInserting(b.id)}
                          onClick={() => insertToSalonboard(b)}
                          title={
                            scope?.shopId
                              ? 'この予約を SalonBoard に登録する'
                              : '店舗を選択すると挿入できます'
                          }
                          className="inline-flex items-center gap-1 rounded-[8px] bg-brand-gradient px-2.5 py-1 text-[11px] font-semibold text-white shadow-brand-sm disabled:opacity-50"
                        >
                          {isInserting(b.id) ? (
                            <Loader2 className="h-3 w-3 animate-spin" />
                          ) : (
                            <UploadCloud className="h-3 w-3" />
                          )}
                          {isInserting(b.id) ? '挿入中…' : 'SalonBoardに挿入'}
                        </button>
                      )}
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

// =====================================================================
// 台帳ビュー (スタッフ縦 × 時間横のタイムライン)
// 読み込み済みの週内予約から1日分を選び、スタッフ行に予約ブロックを配置する。
// 各ブロックに SalonBoard バッジ、「KIREIDOTのみ」には挿入ボタンを付ける。
// =====================================================================
const LEDGER_START_HOUR = 9; // 表示開始
const LEDGER_END_HOUR = 22; // 表示終了
const PX_PER_MIN = 1.4; // 1分あたりのピクセル幅

function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// =====================================================================
// 右上カレンダー (Admin 風)。月を前後でき、日付クリックでその日にジャンプ。
// =====================================================================
function MiniCalendar({
  selected,
  onPick,
  onClose,
}: {
  selected?: string | null;
  onPick: (d: Date) => void;
  onClose: () => void;
}) {
  const todayYmd = ymd(new Date());
  // 表示中の月 (selected があればその月、無ければ今月)
  const initial = selected ? new Date(selected + 'T00:00:00') : new Date();
  const [viewYear, setViewYear] = useState(initial.getFullYear());
  const [viewMonth, setViewMonth] = useState(initial.getMonth()); // 0-based

  const first = new Date(viewYear, viewMonth, 1);
  const startWeekday = first.getDay(); // 0=日
  const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();
  const cells: (Date | null)[] = [];
  for (let i = 0; i < startWeekday; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(new Date(viewYear, viewMonth, d));

  const prevMonth = () => {
    const m = viewMonth - 1;
    if (m < 0) { setViewMonth(11); setViewYear((y) => y - 1); } else setViewMonth(m);
  };
  const nextMonth = () => {
    const m = viewMonth + 1;
    if (m > 11) { setViewMonth(0); setViewYear((y) => y + 1); } else setViewMonth(m);
  };

  return (
    <>
      {/* 外側クリックで閉じる */}
      <div className="fixed inset-0 z-40" onClick={onClose} />
      <div className="absolute right-0 z-50 mt-2 w-[260px] rounded-2xl border border-hairline bg-white p-3 shadow-xl">
        <div className="mb-2 flex items-center justify-between">
          <button type="button" onClick={prevMonth} className="rounded-full p-1 text-ink-soft hover:bg-brand-light/40">
            <ChevronLeft className="h-4 w-4" />
          </button>
          <div className="text-[14px] font-bold text-ink">{viewYear}年 {viewMonth + 1}月</div>
          <button type="button" onClick={nextMonth} className="rounded-full p-1 text-ink-soft hover:bg-brand-light/40">
            <ChevronRight className="h-4 w-4" />
          </button>
        </div>
        <div className="grid grid-cols-7 gap-0.5 text-center text-[10px] text-muted">
          {['日', '月', '火', '水', '木', '金', '土'].map((w) => (
            <div key={w} className="py-1">{w}</div>
          ))}
        </div>
        <div className="grid grid-cols-7 gap-0.5">
          {cells.map((d, i) => {
            if (!d) return <div key={i} />;
            const key = ymd(d);
            const isToday = key === todayYmd;
            const isSelected = key === selected;
            const dow = d.getDay();
            return (
              <button
                key={i}
                type="button"
                onClick={() => onPick(d)}
                className={
                  'aspect-square rounded-lg text-[12px] font-semibold ' +
                  (isSelected
                    ? 'bg-brand-gradient text-white shadow-brand-sm'
                    : isToday
                      ? 'border border-brand-400 text-brand-700'
                      : (dow === 0 ? 'text-rose-500' : dow === 6 ? 'text-sky-600' : 'text-ink') +
                        ' hover:bg-brand-light/40')
                }
              >
                {d.getDate()}
              </button>
            );
          })}
        </div>
        <button
          type="button"
          onClick={() => onPick(new Date())}
          className="mt-2 w-full rounded-lg border border-hairline py-1.5 text-[12px] font-semibold text-ink-soft hover:bg-brand-light/40"
        >
          今日
        </button>
      </div>
    </>
  );
}

/**
 * 同一スタッフ行内で時間が重なる予約に、縦の lane (0-based) を割り当てる。
 * sweep line 方式 (KIREIDOT Admin の layoutGanttOverlaps と同じ考え方)。
 * 重なる予約は別 lane に積まれ、行の高さを lane 数ぶん確保することで
 * 後ろの予約も隠れず見えるようになる。
 */
function layoutLanes(
  list: BookingRow[],
): { lane: Map<string, number>; laneCount: number } {
  const lane = new Map<string, number>();
  if (list.length === 0) return { lane, laneCount: 1 };
  const items = list
    .map((b) => {
      const start = new Date(b.scheduled_at).getTime();
      const dur = (b.duration_min ?? 60) * 60_000;
      return { id: b.id, start, end: start + dur };
    })
    .filter((b) => Number.isFinite(b.start))
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const active: number[] = []; // active[lane] = endTime
  for (const it of items) {
    let l = active.findIndex((endAt) => endAt <= it.start);
    if (l === -1) {
      l = active.length;
      active.push(it.end);
    } else {
      active[l] = it.end;
    }
    lane.set(it.id, l);
  }
  return { lane, laneCount: Math.max(1, active.length) };
}

const LANE_HEIGHT = 30; // 1 lane あたりの高さ(px)
const ROW_VPAD = 4; // 行の上下パディング(px)

function LedgerView({
  bookings,
  staff,
  loading,
  targetDay,
  displayName,
  classify,
  isInserting,
  insertResults,
  onInsert,
  cancelingId,
  cancelResults,
  onCancel,
  changingId,
  changeResults,
  onChange,
}: {
  bookings: BookingRow[];
  staff: StaffRow[];
  loading: boolean;
  /** 右上カレンダーで選んだ日 (この日を優先表示する) */
  targetDay?: string | null;
  displayName: (b: BookingRow) => string;
  classify: (b: BookingRow) => SbBadge;
  isInserting: (id: string) => boolean;
  insertResults: Record<string, { ok: boolean; msg: string }>;
  onInsert: (b: BookingRow, staffExt?: string, staffName?: string) => void;
  cancelingId: string | null;
  cancelResults: Record<string, { ok: boolean; msg: string }>;
  onCancel: (b: BookingRow) => void;
  changingId: string | null;
  changeResults: Record<string, { ok: boolean; msg: string }>;
  onChange: (b: BookingRow, newIso: string, newDurationMin: number) => void;
}) {
  // 期間内の全日付 (予約有無に関わらず。月単位で連続表示するため範囲から生成)
  const days = useMemo(() => {
    const set = new Set<string>();
    for (const b of bookings) set.add(ymd(new Date(b.scheduled_at)));
    return Array.from(set).sort();
  }, [bookings]);

  const [day, setDay] = useState<string>('');
  // 右上カレンダーで選んだ日が来たら最優先で表示
  useEffect(() => {
    if (targetDay) setDay(targetDay);
  }, [targetDay]);
  useEffect(() => {
    // 未選択 or 予約のある日が無いとき: targetDay があればそれ、無ければ先頭の予約日
    if (!day) setDay(targetDay ?? days[0] ?? '');
  }, [days, day, targetDay]);

  // クリックで開く予約詳細
  const [detail, setDetail] = useState<BookingRow | null>(null);

  // 選択日の予約
  const dayBookings = useMemo(
    () => bookings.filter((b) => ymd(new Date(b.scheduled_at)) === day),
    [bookings, day],
  );

  // スタッフ行: SalonBoard 取り込みスタッフ (salonboard_staff_imports) + 「未割当」行。
  // 行のキーは import 行 id を使い、突合済み KIREIDOT staff.id (matched) と
  // SalonBoard external_id / 表示名を保持して、予約をどの行に置くか判定する。
  const staffRows = useMemo(() => {
    const rows = staff.map((s) => ({
      key: s.id,
      name: s.full_name,
      ext: s.external_id ?? null,
      matched: s.matched_staff_id ?? null,
    }));
    rows.push({ key: '__unassigned__', name: '未割当', ext: null, matched: null });
    return rows;
  }, [staff]);

  // 予約をスタッフ行へ割り当てる。
  // 優先順: ① bookings.staff_id == 紐付け済み matched_staff_id (最も確実)
  //         ② SalonBoard external_id 一致
  //         ③ SalonBoard 担当名の一致 (前後の (指) などを除去して比較)
  function staffKeyOf(b: BookingRow): string {
    if (b.staff_id) {
      const hit = staffRows.find((r) => r.matched && r.matched === b.staff_id);
      if (hit) return hit.key;
    }
    if (b.salonboard_staff_external_id) {
      const hit = staffRows.find((r) => r.ext === b.salonboard_staff_external_id);
      if (hit) return hit.key;
    }
    if (b.salonboard_staff_name) {
      const norm = (s: string) => s.replace(/[（(]指[）)]/g, '').trim().toLowerCase();
      const target = norm(b.salonboard_staff_name);
      const hit = staffRows.find((r) => norm(r.name) === target);
      if (hit) return hit.key;
    }
    return '__unassigned__';
  }

  const hours: number[] = [];
  for (let h = LEDGER_START_HOUR; h <= LEDGER_END_HOUR; h++) hours.push(h);
  const gridWidth = (LEDGER_END_HOUR - LEDGER_START_HOUR) * 60 * PX_PER_MIN;

  if (loading) {
    return (
      <Card>
        <div className="flex items-center gap-2 px-5 py-10 text-[13px] text-ink-soft">
          <Loader2 className="h-4 w-4 animate-spin" /> 読み込み中…
        </div>
      </Card>
    );
  }
  if (days.length === 0) {
    return (
      <Card>
        <div className="px-5 py-10 text-center text-[13px] text-ink-soft">この期間に予約がありません。</div>
      </Card>
    );
  }

  return (
    <Card className="overflow-hidden">
      {/* 日付タブ */}
      <div className="flex items-center gap-1.5 overflow-x-auto border-b border-hairline/70 bg-white/50 px-3 py-2">
        {days.map((d) => {
          const dd = new Date(d + 'T00:00:00');
          const n = bookings.filter((b) => ymd(new Date(b.scheduled_at)) === d).length;
          return (
            <button
              key={d}
              type="button"
              onClick={() => setDay(d)}
              className={
                'inline-flex shrink-0 items-center gap-1 rounded-full px-3 py-1 text-[12px] font-semibold ' +
                (day === d ? 'bg-brand-gradient text-white shadow-brand-sm' : 'border border-hairline bg-white/70 text-ink-soft hover:bg-brand-light/40')
              }
            >
              {dd.toLocaleDateString('ja-JP', { month: 'numeric', day: 'numeric', weekday: 'short' })}
              <span className="opacity-70">({n})</span>
            </button>
          );
        })}
      </div>

      <div className="overflow-x-auto">
        <div style={{ minWidth: 120 + gridWidth }}>
          {/* 時間ヘッダ */}
          <div className="flex border-b border-hairline/70 bg-white/40">
            <div className="w-[120px] shrink-0 px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-muted">
              スタッフ
            </div>
            <div className="relative" style={{ width: gridWidth, height: 22 }}>
              {hours.map((h) => (
                <div
                  key={h}
                  className="absolute top-0 border-l border-hairline/50 pl-1 text-[10px] text-muted"
                  style={{ left: (h - LEDGER_START_HOUR) * 60 * PX_PER_MIN }}
                >
                  {h}:00
                </div>
              ))}
            </div>
          </div>

          {/* スタッフ行 */}
          {staffRows.map((row) => {
            const rowBookings = dayBookings.filter((b) => staffKeyOf(b) === row.key);
            // 未割当行は予約があるときだけ表示
            if (row.key === '__unassigned__' && rowBookings.length === 0) return null;
            // 重なり予約を縦 lane に分割 (後ろの予約も隠れず見える)
            const { lane, laneCount } = layoutLanes(rowBookings);
            const rowHeight = laneCount * LANE_HEIGHT + ROW_VPAD * 2;
            return (
              <div key={row.key} className="flex border-b border-hairline/40 hover:bg-brand-light/10">
                <div className="flex w-[120px] shrink-0 items-center px-2 py-1 text-[12px] font-semibold text-ink">
                  <span className="truncate" title={row.name}>{row.name}</span>
                </div>
                <div className="relative" style={{ width: gridWidth, height: rowHeight }}>
                  {/* 時間グリッド線 */}
                  {hours.map((h) => (
                    <div
                      key={h}
                      className="absolute top-0 bottom-0 border-l border-hairline/30"
                      style={{ left: (h - LEDGER_START_HOUR) * 60 * PX_PER_MIN }}
                    />
                  ))}
                  {/* 予約ブロック (lane で縦に分割。クリックで詳細) */}
                  {rowBookings.map((b) => {
                    const dt = new Date(b.scheduled_at);
                    const startMin = dt.getHours() * 60 + dt.getMinutes();
                    const left = (startMin - LEDGER_START_HOUR * 60) * PX_PER_MIN;
                    const width = Math.max((b.duration_min ?? 60) * PX_PER_MIN, 30);
                    const badge = classify(b);
                    const res = insertResults[b.id];
                    const canInsert = badge.kind !== 'salonboard' && !badge.inSalonboard;
                    const l = lane.get(b.id) ?? 0;
                    const top = ROW_VPAD + l * LANE_HEIGHT;
                    return (
                      <button
                        type="button"
                        key={b.id}
                        onClick={() => setDetail(b)}
                        className={`absolute overflow-hidden rounded-[6px] border px-1.5 py-0.5 text-left text-[10px] leading-tight transition-shadow hover:z-20 hover:shadow-md ${
                          badge.inSalonboard
                            ? 'border-emerald-200 bg-emerald-50'
                            : badge.kind === 'salonboard'
                              ? 'border-sky-200 bg-sky-50'
                              : 'border-rose-200 bg-rose-50'
                        }`}
                        style={{ left, width, top, height: LANE_HEIGHT - 2 }}
                        title={`${dt.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })}・${b.duration_min ?? 60}分 / ${displayName(b)} / ${badge.label} (クリックで詳細)`}
                      >
                        <div className="flex items-center gap-1">
                          <span className="truncate font-semibold text-ink">
                            {dt.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })} {displayName(b)}
                          </span>
                        </div>
                        <div className="flex items-center gap-1">
                          <span className={`shrink-0 rounded px-1 py-px text-[9px] font-bold ${badge.cls}`}>{badge.label}</span>
                          {canInsert &&
                            (res ? (
                              <span className={res.ok ? 'text-emerald-700' : 'text-red-600'}>{res.ok ? '✓' : '×'}</span>
                            ) : (
                              <span
                                role="button"
                                tabIndex={0}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  if (!isInserting(b.id)) onInsert(b);
                                }}
                                title="この予約を SalonBoard に挿入"
                                className="inline-flex shrink-0 items-center rounded bg-brand-gradient px-1 py-px text-[9px] font-bold text-white"
                              >
                                {isInserting(b.id) ? '…' : 'SB挿入'}
                              </span>
                            ))}
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* 予約詳細 (ブロッククリックで表示) */}
      {detail && (
        <LedgerDetailModal
          booking={detail}
          displayName={displayName}
          classify={classify}
          isInserting={isInserting}
          insertResults={insertResults}
          onInsert={onInsert}
          cancelingId={cancelingId}
          cancelResults={cancelResults}
          onCancel={onCancel}
          changingId={changingId}
          changeResults={changeResults}
          onChange={onChange}
          onClose={() => setDetail(null)}
        />
      )}
    </Card>
  );
}

// 予約ブロックをクリックしたときの詳細モーダル
function LedgerDetailModal({
  booking: b,
  displayName,
  classify,
  isInserting,
  insertResults,
  onInsert,
  cancelingId,
  cancelResults,
  onCancel,
  changingId,
  changeResults,
  onChange,
  onClose,
}: {
  booking: BookingRow;
  displayName: (b: BookingRow) => string;
  classify: (b: BookingRow) => SbBadge;
  isInserting: (id: string) => boolean;
  insertResults: Record<string, { ok: boolean; msg: string }>;
  onInsert: (b: BookingRow, staffExt?: string, staffName?: string) => void;
  cancelingId: string | null;
  cancelResults: Record<string, { ok: boolean; msg: string }>;
  onCancel: (b: BookingRow) => void;
  changingId: string | null;
  changeResults: Record<string, { ok: boolean; msg: string }>;
  onChange: (b: BookingRow, newIso: string, newDurationMin: number) => void;
  onClose: () => void;
}) {
  const dt = new Date(b.scheduled_at);
  const end = new Date(dt.getTime() + (b.duration_min ?? 60) * 60_000);
  const badge = classify(b);
  const res = insertResults[b.id];
  const cancelRes = cancelResults[b.id];
  const changeRes = changeResults[b.id];
  const canInsert = badge.kind !== 'salonboard' && !badge.inSalonboard;
  const canCancel = b.status !== 'cancelled';
  // 未キャンセルなら時間変更可 (SB連携済みは両方、未連携はKIREIDOTのみ更新)
  const canChange = b.status !== 'cancelled';
  const sbLinked = !!b.external_booking_id;
  // 時間変更フォーム (datetime-local 用の値を初期化)
  const toLocalInput = (d: Date) => {
    const p = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
  };
  const [editMode, setEditMode] = useState(false);
  const [editTime, setEditTime] = useState(() => toLocalInput(dt));
  const [editDur, setEditDur] = useState<number>(b.duration_min ?? 60);
  const fmt = (d: Date) => d.toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', weekday: 'short', hour: '2-digit', minute: '2-digit' });
  const Row = ({ label, value }: { label: string; value: ReactNode }) =>
    value ? (
      <div className="flex gap-3 py-1 text-[13px]">
        <span className="w-24 shrink-0 text-ink-soft">{label}</span>
        <span className="flex-1 text-ink">{value}</span>
      </div>
    ) : null;
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-2xl bg-white p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-start justify-between gap-2">
          <div>
            <div className="text-[17px] font-bold text-ink">{displayName(b)}</div>
            <span className={`mt-1 inline-flex items-center rounded px-1.5 py-0.5 text-[11px] font-bold ${badge.cls}`}>
              {badge.label}
            </span>
          </div>
          <button type="button" onClick={onClose} className="rounded-full p-1 text-ink-soft hover:bg-hairline/40" aria-label="閉じる">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="divide-y divide-hairline/60">
          <Row label="日時" value={`${fmt(dt)} 〜 ${end.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })}`} />
          <Row label="所要" value={`${b.duration_min ?? 60} 分`} />
          <Row
            label="状態"
            value={
              <span className={`inline-flex rounded px-1.5 py-0.5 text-[11px] font-bold ${bookingStatusJp(b.status).cls}`}>
                {bookingStatusJp(b.status).label}
              </span>
            }
          />
          <Row label="担当(SB)" value={b.salonboard_staff_name ?? b.staff?.full_name ?? null} />
          <Row label="メニュー" value={b.menus?.name ?? null} />
          <Row label="出所" value={b.source ?? null} />
          <Row label="SB予約ID" value={b.external_booking_id ?? null} />
          <Row label="顧客コード" value={b.customers?.customer_code ?? null} />
        </div>

        {res && (
          <div className={`mt-3 rounded-lg px-3 py-2 text-[12px] ${res.ok ? 'bg-emerald-50 text-emerald-700' : 'bg-red-50 text-red-700'}`}>
            {res.msg}
          </div>
        )}
        {cancelRes && (
          <div className={`mt-3 rounded-lg px-3 py-2 text-[12px] ${cancelRes.ok ? 'bg-emerald-50 text-emerald-700' : 'bg-red-50 text-red-700'}`}>
            {cancelRes.msg}
          </div>
        )}
        {changeRes && (
          <div className={`mt-3 rounded-lg px-3 py-2 text-[12px] ${changeRes.ok ? 'bg-emerald-50 text-emerald-700' : 'bg-red-50 text-red-700'}`}>
            {changeRes.msg}
          </div>
        )}

        {/* 時間変更フォーム */}
        {canChange && editMode && (
          <div className="mt-3 rounded-lg border border-hairline bg-brand-light/20 p-3">
            <div className="mb-2 text-[12px] font-semibold text-ink">
              予約時間を変更 {sbLinked ? '(KIREIDOT + SalonBoard)' : '(KIREIDOTのみ・SB未連携)'}
            </div>
            <div className="flex flex-wrap items-end gap-3">
              <label className="flex flex-col gap-1 text-[11px] text-ink-soft">
                日時
                <input
                  type="datetime-local"
                  value={editTime}
                  onChange={(e) => setEditTime(e.target.value)}
                  className="rounded-lg border border-hairline px-2 py-1 text-[13px] text-ink"
                />
              </label>
              <label className="flex flex-col gap-1 text-[11px] text-ink-soft">
                所要(分)
                <input
                  type="number"
                  min={15}
                  step={15}
                  value={editDur}
                  onChange={(e) => setEditDur(Number(e.target.value) || 60)}
                  className="w-20 rounded-lg border border-hairline px-2 py-1 text-[13px] text-ink"
                />
              </label>
              <button
                type="button"
                disabled={changingId === b.id}
                onClick={() => {
                  // datetime-local はローカル時刻。JST(+09:00) ISO に変換して渡す。
                  const [d, t] = editTime.split('T');
                  if (!d || !t) return;
                  const iso = `${d}T${t}:00+09:00`;
                  onChange(b, iso, editDur);
                  setEditMode(false);
                }}
                className="rounded-lg bg-brand-gradient px-3 py-1.5 text-[13px] font-semibold text-white disabled:opacity-40"
              >
                {changingId === b.id ? '変更中…' : 'この内容で変更'}
              </button>
              <button
                type="button"
                onClick={() => setEditMode(false)}
                className="rounded-lg border border-hairline px-3 py-1.5 text-[13px] font-semibold text-ink-soft hover:bg-brand-light/40"
              >
                やめる
              </button>
            </div>
          </div>
        )}

        <div className="mt-4 flex flex-wrap items-center justify-end gap-2">
          {/* 時間変更 */}
          {canChange && !editMode && !changeRes && (
            <button
              type="button"
              onClick={() => setEditMode(true)}
              title={sbLinked ? 'KIREIDOT と SalonBoard の予約時間を変更します' : 'KIREIDOT の予約時間を変更します (SalonBoard 未連携)'}
              className="inline-flex items-center gap-1 rounded-lg border border-brand-400 px-3 py-1.5 text-[13px] font-semibold text-brand-700 hover:bg-brand-light/40"
            >
              {sbLinked ? '時間を変更 (SBも)' : '時間を変更'}
            </button>
          )}
          {/* キャンセル (左寄せ) */}
          {canCancel && !cancelRes && (
            <button
              type="button"
              onClick={() => onCancel(b)}
              disabled={cancelingId === b.id}
              title={b.external_booking_id ? 'KIREIDOT と SalonBoard の両方でキャンセルします' : 'SalonBoard 未連携のため KIREIDOT のみキャンセルします'}
              className="mr-auto inline-flex items-center gap-1 rounded-lg border border-red-300 px-3 py-1.5 text-[13px] font-semibold text-red-600 hover:bg-red-50 disabled:opacity-40"
            >
              {cancelingId === b.id ? 'キャンセル中…' : (b.external_booking_id ? 'キャンセル (SBも)' : 'キャンセル')}
            </button>
          )}
          {b.salonboard_detail_url && (
            <a
              href={b.salonboard_detail_url}
              target="_blank"
              rel="noreferrer"
              className="rounded-lg border border-hairline px-3 py-1.5 text-[13px] font-semibold text-ink-soft hover:bg-brand-light/40"
            >
              SalonBoardで開く
            </a>
          )}
          {canInsert && !res && (
            <button
              type="button"
              onClick={() => onInsert(b)}
              disabled={isInserting(b.id)}
              className="inline-flex items-center gap-1 rounded-lg bg-brand-gradient px-3 py-1.5 text-[13px] font-semibold text-white disabled:opacity-40"
            >
              <UploadCloud className="h-4 w-4" />
              {isInserting(b.id) ? '挿入中…' : 'SalonBoardに挿入'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
