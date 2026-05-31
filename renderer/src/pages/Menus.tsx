import { useEffect, useMemo, useState } from 'react';
import { Loader2, BookOpen, CheckCircle2, RefreshCcw, FlaskConical, AlertTriangle } from 'lucide-react';
import { Card } from '../components/Card';
import { useEffectiveScope } from '../lib/selection-context';
import { fetchMenusMerged, fetchStaffList, fetchMenuList, type MergedMenuRow, type StaffRow, type MenuRow } from '../lib/data';
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
      {/* 予約書き込みテスト (制約が通るかだけを単発で検証) */}
      <PushTestPanel />

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

// =====================================================================
// 予約書き込みテストパネル
// ジョブキューを通さず、選んだスタッフ・メニュー・日時 (既定 2026/6/10 13:00) で
// 1 件だけ SalonBoard 登録フォームを操作し、制約が通るかを検証する。
// 「実登録」ON のときだけ登録ボタンを押す。各ステップを画面に表示。
// =====================================================================
type TestLine = { at: string; text: string; kind: 'info' | 'ok' | 'error' };

function PushTestPanel() {
  const scope = useEffectiveScope();
  const [staff, setStaff] = useState<StaffRow[]>([]);
  const [menus, setMenus] = useState<MenuRow[]>([]);
  const [staffExt, setStaffExt] = useState('');
  const [menuName, setMenuName] = useState('');
  const [date, setDate] = useState('2026-06-10');
  const [time, setTime] = useState('13:00');
  const [duration, setDuration] = useState('60');
  const [customer, setCustomer] = useState('テスト 予約');
  const [enablePush, setEnablePush] = useState(false);
  const [running, setRunning] = useState(false);
  const [lines, setLines] = useState<TestLine[]>([]);
  const [loadingOpts, setLoadingOpts] = useState(true);

  const bridge = typeof window !== 'undefined' ? window.kireidotApp : undefined;

  useEffect(() => {
    if (!scope) return;
    let cancelled = false;
    setLoadingOpts(true);
    Promise.all([fetchStaffList(scope), fetchMenuList(scope)])
      .then(([st, mn]) => {
        if (cancelled) return;
        const withExt = st.filter((s) => !!s.external_id);
        setStaff(withExt);
        setMenus(mn);
        if (withExt[0]?.external_id) setStaffExt(withExt[0].external_id);
        if (mn[0]) setMenuName(mn[0].name);
      })
      .finally(() => !cancelled && setLoadingOpts(false));
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope?.shopId]);

  // worker からのテスト結果イベントを購読
  useEffect(() => {
    if (!bridge?.onWorkerEvent) return;
    return bridge.onWorkerEvent((msg) => {
      if (msg.type !== 'push:test') return;
      const p = msg.payload;
      const now = new Date().toLocaleTimeString('ja-JP');
      if (p.step === 'done') {
        setRunning(false);
        if (p.ok) {
          setLines((c) => [...c, { at: now, text: p.msg || (p.registered ? '✅ 登録完了' : '🟡 入力まで成功'), kind: 'ok' }]);
        } else {
          setLines((c) => [...c, { at: now, text: p.error || `失敗 (${p.errorCode || 'unknown'})`, kind: 'error' }]);
        }
      } else {
        setLines((c) => [...c, { at: now, text: p.msg || p.step, kind: 'info' }]);
      }
    });
  }, [bridge]);

  // メニューは任意 (SalonBoard 予約フォームでは未選択でも登録可能)。
  const canRun =
    !!scope?.shopId && !!staffExt && /^\d{4}-\d{2}-\d{2}$/.test(date) && /^\d{1,2}:\d{2}$/.test(time) && !running;

  const run = async () => {
    if (!scope?.shopId || !bridge?.workerTestPush) return;
    setLines([]);
    setRunning(true);
    const sel = staff.find((s) => s.external_id === staffExt);
    const scheduledAt = `${date}T${time.length === 4 ? '0' + time : time}:00+09:00`;
    await bridge.workerTestPush({
      shopId: scope.shopId,
      staffExternalId: staffExt,
      staffName: sel?.full_name ?? null,
      menuName: menuName.trim(),
      scheduledAt,
      durationMin: Number(duration) > 0 ? Number(duration) : 60,
      customerName: customer.trim() || null,
      enablePush,
    });
    // 安全網: 90 秒で running 解除 (done が来なかった場合)
    setTimeout(() => setRunning(false), 90_000);
  };

  if (!bridge?.workerTestPush) {
    return null; // ブラウザ版では非表示
  }

  const ic = 'h-10 w-full rounded-[10px] border border-hairline bg-white px-3 text-[13px] focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/20';

  return (
    <Card className="border-amber-200">
      <div className="border-b border-hairline/70 bg-amber-50/60 px-5 py-3">
        <div className="flex items-center gap-2 text-[14px] font-bold text-ink">
          <FlaskConical className="h-4 w-4 text-amber-600" /> 予約書き込みテスト
        </div>
        <p className="mt-0.5 text-[11px] text-ink-soft">
          選んだスタッフ・メニュー・日時で 1 件だけ SalonBoard 登録フォームを操作し、書き込めるか検証します
          (ジョブキューを通しません)。
        </p>
      </div>
      <div className="px-5 py-4">
        {!scope?.shopId ? (
          <p className="text-[12px] text-ink-soft">先に店舗を選択してください。</p>
        ) : loadingOpts ? (
          <div className="flex items-center gap-2 text-[12px] text-ink-soft">
            <Loader2 className="h-4 w-4 animate-spin" /> スタッフ・メニュー読み込み中…
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <label className="flex flex-col gap-1">
                <span className="text-[10px] uppercase tracking-wide text-muted">日付</span>
                <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className={ic} />
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-[10px] uppercase tracking-wide text-muted">時刻</span>
                <input type="time" value={time} onChange={(e) => setTime(e.target.value)} className={ic} />
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-[10px] uppercase tracking-wide text-muted">所要(分)</span>
                <input type="number" min={5} step={5} value={duration} onChange={(e) => setDuration(e.target.value)} className={ic} />
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-[10px] uppercase tracking-wide text-muted">顧客名</span>
                <input type="text" value={customer} onChange={(e) => setCustomer(e.target.value)} className={ic} />
              </label>
            </div>
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              <label className="flex flex-col gap-1">
                <span className="text-[10px] uppercase tracking-wide text-muted">担当スタッフ</span>
                {staff.length === 0 ? (
                  <span className="text-[11px] text-amber-700">external_id 付きスタッフ無し (先にスタッフ同期)</span>
                ) : (
                  <select value={staffExt} onChange={(e) => setStaffExt(e.target.value)} className={ic}>
                    {staff.map((s) => (
                      <option key={s.id} value={s.external_id ?? ''}>{s.full_name}（{s.external_id}）</option>
                    ))}
                  </select>
                )}
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-[10px] uppercase tracking-wide text-muted">メニュー (任意)</span>
                {menus.length === 0 ? (
                  <input type="text" value={menuName} onChange={(e) => setMenuName(e.target.value)} placeholder="メニュー名 (任意・空でOK)" className={ic} />
                ) : (
                  <select value={menuName} onChange={(e) => setMenuName(e.target.value)} className={ic}>
                    <option value="">（メニューなし）</option>
                    {menus.map((m) => (
                      <option key={m.id} value={m.name}>{m.category ? `[${m.category}] ` : ''}{m.name}</option>
                    ))}
                  </select>
                )}
              </label>
            </div>

            <label className="flex items-center gap-2 text-[12px]">
              <input type="checkbox" checked={enablePush} onChange={(e) => setEnablePush(e.target.checked)} className="h-4 w-4 accent-brand" />
              <span className={enablePush ? 'font-semibold text-amber-700' : 'text-ink-soft'}>
                実登録する (ON: 登録ボタンを押して SalonBoard に実際に登録 / OFF: 入力まで)
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
                {running ? 'テスト実行中… (ブラウザが開きます)' : 'テスト実行'}
              </button>
            </div>

            {lines.length > 0 && (
              <div className="mt-1 rounded-[10px] border border-hairline bg-surface-soft/60 p-3">
                <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted">実行ログ</div>
                <div className="flex flex-col gap-0.5 font-mono text-[11px]">
                  {lines.map((l, i) => (
                    <div
                      key={i}
                      className={
                        l.kind === 'ok' ? 'text-emerald-700' : l.kind === 'error' ? 'text-red-600' : 'text-ink-soft'
                      }
                    >
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
