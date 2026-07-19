import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  BookOpen,
  Building2,
  CalendarClock,
  CalendarRange,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Eye,
  EyeOff,
  Image as ImageIcon,
  Loader2,
  Lock,
  Moon,
  Newspaper,
  Pause,
  Pencil,
  PlayCircle,
  PlugZap,
  RefreshCcw,
  Scissors,
  ShieldCheck,
  ShieldOff,
  Store,
  Ticket,
  TriangleAlert,
  Trash2,
  Users,
  X,
} from 'lucide-react';
import { Card, CardBody, CardHeader } from '../components/Card';
import { useAuth } from '../lib/auth-context';
import { useSelection } from '../lib/selection-context';
import { useSyncController, type ChannelKey } from '../lib/sync-controller';
import {
  deleteSalonboardCredentials,
  fetchCredentialOverview,
  fetchRecentSyncRuns,
  revealSalonboardCredentials,
  setSalonboardCredentialEnabled,
  setSalonboardChromeProfile,
  shopGenreLabel,
  upsertSalonboardCredentials,
  type CredentialOverviewRow,
  type SyncRunRow,
} from '../lib/salonboard';

/**
 * 会社×店舗のサロンボード認証情報を一覧・編集するページ。
 *
 * - super_owner / admin: 全社・全店舗を編集できる
 * - それ以外: 自組織のみ閲覧 (RLS により書き込みは拒否される)
 */
export function SalonboardPage() {
  const auth = useAuth();
  const { selectedOrgId, selectedShopId } = useSelection();
  // 認証情報の編集権限:
  //   - super_owner / admin: 全社・全店舗を編集可
  //   - owner / shop_manager: 自社の店舗のみ編集可 (RLS で弾く)
  //   - staff / user: 閲覧のみ
  const canEdit =
    auth.status === 'signed-in'
    && (
      auth.scope.role === 'super_owner'
      || auth.scope.role === 'admin'
      || auth.scope.role === 'owner'
      || auth.scope.role === 'shop_manager'
    );

  const sync = useSyncController();
  const [rows, setRows] = useState<CredentialOverviewRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [openOrg, setOpenOrg] = useState<Record<string, boolean>>({});
  const [editing, setEditing] = useState<CredentialOverviewRow | null>(null);
  const [history, setHistory] = useState<SyncRunRow[]>([]);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [list, runs] = await Promise.all([
        fetchCredentialOverview(),
        fetchRecentSyncRuns(20),
      ]);
      setRows(list);
      setHistory(runs);
      // 初回は全社を開いておく
      const initial: Record<string, boolean> = {};
      for (const r of list) initial[r.organization_id] = true;
      setOpenOrg((cur) => (Object.keys(cur).length === 0 ? initial : cur));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'データ取得に失敗しました');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  // 同期完了時に履歴を自動更新
  useEffect(() => {
    if (sync.lastRun?.done) {
      void (async () => {
        const runs = await fetchRecentSyncRuns(20);
        setHistory(runs);
      })();
    }
  }, [sync.lastRun?.done]);

  // 選択中の会社で絞り込み。さらに店舗まで選択中なら 1 店舗に絞る。
  const scopedRows = useMemo(() => {
    if (!selectedOrgId) return [];
    let list = rows.filter((r) => r.organization_id === selectedOrgId);
    if (selectedShopId) list = list.filter((r) => r.shop_id === selectedShopId);
    return list;
  }, [rows, selectedOrgId, selectedShopId]);

  // 会社単位でグルーピング (実質 1 グループ)
  const grouped = useMemo(() => {
    const m = new Map<string, { name: string; shops: CredentialOverviewRow[] }>();
    for (const r of scopedRows) {
      const e = m.get(r.organization_id);
      if (e) e.shops.push(r);
      else m.set(r.organization_id, { name: r.organization_name, shops: [r] });
    }
    return Array.from(m.entries()).map(([orgId, v]) => ({
      orgId,
      orgName: v.name,
      shops: v.shops,
    }));
  }, [scopedRows]);

  const totalShops = scopedRows.length;
  const linkedShops = scopedRows.filter((r) => r.has_credential).length;
  const errorShops = scopedRows.filter((r) => (r.consecutive_failures ?? 0) > 0).length;
  /** 「全店舗を同期」で渡す shop_id 一覧。選択中組織で連携済みかつ有効な店舗のみ。 */
  const orgShopIds = useMemo(
    () => scopedRows.filter((r) => r.has_credential && r.enabled).map((r) => r.shop_id),
    [scopedRows],
  );

  return (
    <div className="flex flex-col gap-5 pt-4">
      {/* ヘッダー */}
      <Card>
        <CardHeader
          title="サロンボード連携"
          subtitle="会社ごとに、各店舗のサロンボード ID / パスワードを登録・管理します。"
        />
        <CardBody>
          <div className="flex flex-wrap items-center gap-3">
            <Stat label="登録店舗" value={`${linkedShops} / ${totalShops}`} icon={<PlugZap className="h-3.5 w-3.5" />} />
            <Stat label="エラー中" value={String(errorShops)} icon={<TriangleAlert className="h-3.5 w-3.5" />} accent="amber" />
            {sync.lastRun && sync.lastRun.done && (
              <Stat
                label="最終同期"
                value={`成功 ${sync.lastRun.ok} / 失敗 ${sync.lastRun.ng}`}
                icon={<CheckCircle2 className="h-3.5 w-3.5" />}
              />
            )}
            <button
              type="button"
              onClick={() => void reload()}
              className="ml-auto inline-flex items-center gap-1.5 rounded-[10px] border border-hairline bg-white px-3 py-1.5 text-[11px] font-semibold text-ink-soft hover:bg-brand-light/40"
            >
              <RefreshCcw className="h-3.5 w-3.5" /> 再読込
            </button>
            {sync.isRunning ? (
              <button
                type="button"
                onClick={() => void sync.abort()}
                className="inline-flex items-center gap-1.5 rounded-[10px] border border-red-200 bg-red-50 px-3 py-1.5 text-[11px] font-semibold text-red-700 hover:bg-red-100"
              >
                <Pause className="h-3.5 w-3.5" /> 中断
              </button>
            ) : (
              <button
                type="button"
                disabled={!sync.ready || orgShopIds.length === 0}
                onClick={() => void sync.syncShops(orgShopIds)}
                className="inline-flex items-center gap-1.5 rounded-[10px] bg-brand-gradient px-3 py-1.5 text-[11px] font-semibold text-white shadow-brand-sm disabled:opacity-50"
                title={
                  selectedShopId
                    ? '選択中の店舗をすべて同期'
                    : 'この会社の全店舗をバックグラウンドで同期'
                }
              >
                <PlayCircle className="h-3.5 w-3.5" />{' '}
                {selectedShopId ? 'この店舗を一括同期' : '会社の全店舗を一括同期'}
              </button>
            )}
            {!sync.isRunning && (
              <button
                type="button"
                disabled={!sync.ready || orgShopIds.length === 0}
                onClick={() =>
                  void sync.syncShops(orgShopIds, undefined, { showBrowser: true })
                }
                className="inline-flex items-center gap-1.5 rounded-[10px] border border-brand-300 bg-white px-3 py-1.5 text-[11px] font-semibold text-brand-700 hover:bg-brand-light/40 disabled:opacity-50"
                title="ブラウザ画面を表示しながら同期 (デバッグ用)"
              >
                <PlayCircle className="h-3.5 w-3.5" /> 表示しながら一括同期
              </button>
            )}
            <label
              className="inline-flex cursor-pointer items-center gap-2 rounded-[10px] border border-hairline bg-white px-3 py-1.5 text-[11px] font-semibold text-ink-soft hover:bg-brand-light/20"
              title={
                sync.autoSyncEnabled
                  ? '自動同期 ON: 設定された間隔で全項目を自動実行 (稼働は 6:00〜24:00 のみ。0:00〜6:00 は停止)'
                  : '自動同期 OFF: 手動で実行する必要があります'
              }
            >
              <input
                type="checkbox"
                checked={sync.autoSyncEnabled}
                onChange={(e) => sync.setAutoSyncEnabled(e.target.checked)}
                className="h-3 w-3 accent-brand"
                disabled={!sync.ready}
              />
              <RefreshCcw className="h-3.5 w-3.5" />
              自動同期 (全項目)
            </label>
            <label
              className={
                'inline-flex cursor-pointer items-center gap-2 rounded-[10px] border px-3 py-1.5 text-[11px] font-semibold transition ' +
                (sync.bookingsAutoSyncEnabled
                  ? 'border-brand-300 bg-brand-light/40 text-brand-700'
                  : 'border-hairline bg-white text-ink-soft hover:bg-brand-light/20')
              }
              title={
                sync.bookingsAutoSyncEnabled
                  ? '予約だけを店舗ごとに 50〜70 分のランダム間隔で自動取得 (ほぼ毎時 / BAN 回避のため間隔を一定にしない)。稼働は 6:00〜24:00 のみ、0:00〜6:00 は停止'
                  : '予約だけを店舗ごとに 50〜70 分のランダム間隔で自動取得 (OFF)'
              }
            >
              <input
                type="checkbox"
                checked={sync.bookingsAutoSyncEnabled}
                onChange={(e) => sync.setBookingsAutoSyncEnabled(e.target.checked)}
                className="h-3 w-3 accent-brand"
                disabled={!sync.ready}
              />
              <CalendarRange className="h-3.5 w-3.5" />
              予約のみ 毎時(店舗ごと50〜70分)
              {sync.lastBookingsAutoSyncAt && (
                <span className="ml-1 text-[10px] font-normal text-ink-soft">
                  ({new Date(sync.lastBookingsAutoSyncAt).toLocaleTimeString('ja-JP', {
                    hour: '2-digit',
                    minute: '2-digit',
                  })})
                </span>
              )}
            </label>
            {/* 自動取得 ON だが夜間 (0:00〜6:00) で停止中であることを示すバッジ */}
            {(sync.autoSyncEnabled || sync.bookingsAutoSyncEnabled) &&
              !sync.isAutoSyncActiveNow && (
                <span
                  className="inline-flex items-center gap-1.5 rounded-[10px] border border-indigo-200 bg-indigo-50 px-3 py-1.5 text-[11px] font-semibold text-indigo-700"
                  title={`自動取得は ${sync.activeHours.startHour}:00〜${sync.activeHours.endHour === 24 ? '24:00' : `${sync.activeHours.endHour}:00`} のみ稼働します。夜間 (${sync.activeHours.endHour === 24 ? '0' : sync.activeHours.endHour}:00〜${sync.activeHours.startHour}:00) は停止中です。手動同期はいつでも実行できます。`}
                >
                  <Moon className="h-3.5 w-3.5" />
                  夜間停止中（{sync.activeHours.startHour}:00〜再開）
                </span>
              )}
          </div>

          {/* 項目別の同期ボタン */}
          <div className="mt-3 flex flex-wrap items-center gap-2 rounded-[10px] border border-hairline bg-white/70 px-3 py-2">
            <span className="text-[10px] font-bold uppercase tracking-wider text-muted">
              項目別で同期
            </span>
            <ChannelSyncButton
              icon={<CalendarRange className="h-3 w-3" />}
              label="予約"
              channel="bookings"
              shopIds={orgShopIds}
              disabled={!sync.ready || sync.isRunning || orgShopIds.length === 0}
              onSync={(ch, opts) =>
                sync.syncShops(orgShopIds, [ch], { showBrowser: !!opts?.showBrowser })
              }
            />
            <ChannelSyncButton
              icon={<Users className="h-3 w-3" />}
              label="スタッフ"
              channel="staff"
              shopIds={orgShopIds}
              disabled={!sync.ready || sync.isRunning || orgShopIds.length === 0}
              onSync={(ch, opts) =>
                sync.syncShops(orgShopIds, [ch], { showBrowser: !!opts?.showBrowser })
              }
            />
            <ChannelSyncButton
              icon={<BookOpen className="h-3 w-3" />}
              label="メニュー"
              channel="menus"
              shopIds={orgShopIds}
              disabled={!sync.ready || sync.isRunning || orgShopIds.length === 0}
              onSync={(ch, opts) =>
                sync.syncShops(orgShopIds, [ch], { showBrowser: !!opts?.showBrowser })
              }
            />
            <ChannelSyncButton
              icon={<Ticket className="h-3 w-3" />}
              label="クーポン"
              channel="coupons"
              shopIds={orgShopIds}
              disabled={!sync.ready || sync.isRunning || orgShopIds.length === 0}
              onSync={(ch, opts) =>
                sync.syncShops(orgShopIds, [ch], { showBrowser: !!opts?.showBrowser })
              }
            />
            <ChannelSyncButton
              icon={<CalendarClock className="h-3 w-3" />}
              label="シフト"
              channel="shifts"
              shopIds={orgShopIds}
              disabled={!sync.ready || sync.isRunning || orgShopIds.length === 0}
              onSync={(ch, opts) =>
                sync.syncShops(orgShopIds, [ch], { showBrowser: !!opts?.showBrowser })
              }
            />
            <ChannelSyncButton
              icon={<Newspaper className="h-3 w-3" />}
              label="ブログ"
              channel="blog"
              shopIds={orgShopIds}
              disabled={!sync.ready || sync.isRunning || orgShopIds.length === 0}
              onSync={(ch, opts) =>
                sync.syncShops(orgShopIds, [ch], { showBrowser: !!opts?.showBrowser })
              }
            />
            <span className="ml-1 text-[10px] text-ink-soft">
              {selectedShopId
                ? '選択中の店舗のみ実行'
                : `この会社の連携店舗 ${orgShopIds.length} 件に実行`}
            </span>
          </div>

          {sync.isRunning && sync.lastRun && (
            <div className="mt-3 rounded-[10px] bg-brand-light/40 px-3 py-2 text-[11px] text-brand-700">
              <Loader2 className="mr-1.5 inline h-3 w-3 animate-spin" />
              同期中… 成功 {sync.lastRun.ok} / 失敗 {sync.lastRun.ng} / 全{' '}
              {sync.lastRun.total} 店舗
            </div>
          )}
          {!canEdit && auth.status === 'signed-in' && (
            <div className="mt-3 flex items-start gap-2 rounded-[10px] bg-amber-50 px-3 py-2 text-[11px] text-amber-800">
              <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>
                認証情報の編集は <strong>owner / shop_manager / admin / super_owner</strong> ロールのみ可能です。閲覧モードで表示しています。
              </span>
            </div>
          )}
          {!sync.ready && canEdit && (
            <div className="mt-3 flex items-start gap-2 rounded-[10px] bg-amber-50 px-3 py-2 text-[11px] text-amber-800">
              <Loader2 className="mt-0.5 h-3.5 w-3.5 shrink-0 animate-spin" />
              <span>
                同期ワーカーを初期化しています… (Supabase セッション引き継ぎ中)
              </span>
            </div>
          )}
          {error && (
            <div className="mt-3 rounded-[10px] bg-red-50 px-3 py-2 text-[11px] text-red-700">
              {error}
            </div>
          )}
        </CardBody>
      </Card>

      {/* 会社×店舗グリッド */}
      {loading ? (
        <div className="flex items-center justify-center gap-2 py-10 text-[12px] text-ink-soft">
          <Loader2 className="h-4 w-4 animate-spin" /> 読み込み中…
        </div>
      ) : !selectedOrgId ? (
        <Card>
          <CardBody>
            <p className="text-[12px] text-ink-soft">
              右上で操作対象の会社を選択してください。
            </p>
          </CardBody>
        </Card>
      ) : grouped.length === 0 ? (
        <Card>
          <CardBody>
            <p className="text-[12px] text-ink-soft">
              この会社にはサロンボード連携対象の店舗がありません。
            </p>
          </CardBody>
        </Card>
      ) : (
        grouped.map((g) => {
          const open = openOrg[g.orgId] !== false;
          const linked = g.shops.filter((s) => s.has_credential).length;
          return (
            <Card key={g.orgId}>
              <button
                type="button"
                onClick={() => setOpenOrg((c) => ({ ...c, [g.orgId]: !open }))}
                className="flex w-full items-center gap-3 px-5 py-4 text-left hover:bg-brand-light/20"
              >
                <span className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-brand-light text-brand-700">
                  <Building2 className="h-4 w-4" />
                </span>
                <div className="flex-1 min-w-0">
                  <div className="text-[13px] font-semibold text-ink">{g.orgName}</div>
                  <div className="text-[11px] text-ink-soft">
                    店舗 {g.shops.length} 件 ・ 連携済み {linked} 件
                  </div>
                </div>
                {open ? (
                  <ChevronDown className="h-4 w-4 text-ink-soft" />
                ) : (
                  <ChevronRight className="h-4 w-4 text-ink-soft" />
                )}
              </button>
              {open && (
                <CardBody className="border-t border-hairline pt-3">
                  <div className="grid grid-cols-1 gap-2.5 md:grid-cols-2">
                    {g.shops.map((s) => (
                      <ShopCredentialCard
                        key={s.shop_id}
                        row={s}
                        canEdit={canEdit}
                        onEdit={() => setEditing(s)}
                        onReload={reload}
                        syncStatus={sync.shopStatuses[s.shop_id]}
                        isRunning={sync.isRunning}
                        ready={sync.ready}
                        onSync={async (opts) => {
                          const r = await sync.syncShops(
                            [s.shop_id],
                            opts?.channels,
                            { showBrowser: !!opts?.showBrowser },
                          );
                          if (!r.ok && r.error) {
                            alert(`同期を開始できませんでした: ${r.error}`);
                          }
                        }}
                      />
                    ))}
                  </div>
                </CardBody>
              )}
            </Card>
          );
        })
      )}

      {/* Worker ログ (デバッグ用) */}
      {sync.logs.length > 0 && (
        <Card>
          <CardHeader
            title="同期ワーカーログ"
            subtitle="直近 200 件まで保持。エラー時の手がかりに。"
          />
          <CardBody>
            <div className="max-h-48 overflow-y-auto rounded-[10px] bg-slate-50 p-2 font-mono text-[10px] text-ink-soft">
              {sync.logs.slice(-30).map((l, i) => (
                <div
                  key={i}
                  className={
                    l.level === 'error'
                      ? 'text-red-700'
                      : l.level === 'warn'
                        ? 'text-amber-700'
                        : 'text-ink-soft'
                  }
                >
                  [{new Date(l.at).toLocaleTimeString('ja-JP')}] [{l.level}] {l.msg}
                </div>
              ))}
            </div>
          </CardBody>
        </Card>
      )}

      {/* 同期実行履歴 */}
      <Card>
        <CardHeader title="同期実行履歴" subtitle="最近の「同期」実行の結果。失敗があれば各店舗の last_error も合わせて確認できます。" />
        <CardBody>
          {history.length === 0 ? (
            <p className="text-[12px] text-ink-soft">まだ同期実行履歴がありません。</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-[12px]">
                <thead>
                  <tr className="border-b border-hairline text-left text-[10px] uppercase text-muted">
                    <th className="py-2 pr-3">開始</th>
                    <th className="py-2 pr-3">完了</th>
                    <th className="py-2 pr-3">店舗</th>
                    <th className="py-2 pr-3">予約</th>
                    <th className="py-2 pr-3">スタッフ</th>
                    <th className="py-2 pr-3">ブログ</th>
                    <th className="py-2 pr-3">顧客</th>
                    <th className="py-2 pr-3">チャネル</th>
                    <th className="py-2">ソース</th>
                  </tr>
                </thead>
                <tbody>
                  {history.map((r) => (
                    <tr key={r.id} className="border-b border-hairline/60">
                      <td className="py-2 pr-3 whitespace-nowrap">
                        {new Date(r.started_at).toLocaleString('ja-JP')}
                      </td>
                      <td className="py-2 pr-3 whitespace-nowrap">
                        {r.finished_at ? (
                          <span className="text-emerald-700">
                            {new Date(r.finished_at).toLocaleTimeString('ja-JP')}
                          </span>
                        ) : (
                          <span className="text-amber-700">実行中</span>
                        )}
                      </td>
                      <td className="py-2 pr-3">
                        <span className="font-semibold text-emerald-700">{r.ok_shops}</span>
                        <span className="text-ink-soft"> / </span>
                        <span className={r.ng_shops > 0 ? 'font-semibold text-red-700' : 'text-ink-soft'}>
                          {r.ng_shops}
                        </span>
                        <span className="text-ink-soft"> ({r.total_shops})</span>
                      </td>
                      <td className="py-2 pr-3 tabular-nums">{r.total_bookings}</td>
                      <td className="py-2 pr-3 tabular-nums">{r.total_staff}</td>
                      <td className="py-2 pr-3 tabular-nums">{r.total_blogs}</td>
                      <td className="py-2 pr-3 tabular-nums">{r.total_customers}</td>
                      <td className="py-2 pr-3 text-[10px] text-ink-soft">
                        {(r.channels ?? []).join(', ')}
                      </td>
                      <td className="py-2 text-[10px] text-ink-soft">
                        {r.aborted ? <span className="text-red-700">中断</span> : r.source ?? 'desktop'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardBody>
      </Card>

      {editing && (
        <EditModal
          row={editing}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            await reload();
          }}
        />
      )}
    </div>
  );
}

/**
 * チャネル別の同期ボタン。クリックでバックグラウンド同期。
 * 右端の小さい「👁」を押すとブラウザを表示しながら同期する (デバッグ用)。
 */
function ChannelSyncButton({
  icon,
  label,
  channel,
  shopIds,
  disabled,
  onSync,
}: {
  icon: React.ReactNode;
  label: string;
  channel: ChannelKey;
  shopIds: string[];
  disabled?: boolean;
  onSync: (ch: ChannelKey, opts?: { showBrowser?: boolean }) => Promise<{ ok: boolean; error?: string }>;
}) {
  return (
    <span className="inline-flex overflow-hidden rounded-[8px] border border-brand-200 bg-white">
      <button
        type="button"
        disabled={disabled || shopIds.length === 0}
        onClick={async () => {
          const r = await onSync(channel);
          if (!r.ok && r.error) alert(`同期を開始できませんでした: ${r.error}`);
        }}
        title={`${label}のみを同期 (バックグラウンド)`}
        className="inline-flex items-center gap-1 bg-brand-light/60 px-2.5 py-1 text-[11px] font-semibold text-brand-700 hover:bg-brand-light disabled:opacity-50"
      >
        {icon}
        {label}
      </button>
      <button
        type="button"
        disabled={disabled || shopIds.length === 0}
        onClick={async () => {
          const r = await onSync(channel, { showBrowser: true });
          if (!r.ok && r.error) alert(`同期を開始できませんでした: ${r.error}`);
        }}
        title={`${label}を「ブラウザ表示しながら」同期 (デバッグ用)`}
        className="border-l border-brand-200 px-1.5 py-1 text-brand-700 hover:bg-brand-light/40 disabled:opacity-50"
      >
        <Eye className="h-3 w-3" />
      </button>
    </span>
  );
}

function Stat({
  label,
  value,
  icon,
  accent,
}: {
  label: string;
  value: string;
  icon?: React.ReactNode;
  accent?: 'amber';
}) {
  const tone =
    accent === 'amber' ? 'bg-amber-50 text-amber-700' : 'bg-brand-light text-brand-700';
  return (
    <div className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[11px] font-semibold ${tone}`}>
      {icon}
      <span className="opacity-70">{label}</span>
      <span>{value}</span>
    </div>
  );
}

function ShopCredentialCard({
  row,
  canEdit,
  onEdit,
  onReload,
  syncStatus,
  isRunning,
  ready,
  onSync,
}: {
  row: CredentialOverviewRow;
  canEdit: boolean;
  onEdit: () => void;
  onReload: () => Promise<void>;
  syncStatus?: import('../lib/sync-controller').ShopSyncStatus;
  isRunning: boolean;
  ready: boolean;
  onSync: (opts?: { showBrowser?: boolean; channels?: ChannelKey[] }) => void;
}) {
  const linked = row.has_credential;
  const [busy, setBusy] = useState<'enable' | 'delete' | null>(null);
  const [actionErr, setActionErr] = useState<string | null>(null);

  async function toggle() {
    if (!canEdit) return;
    setBusy('enable');
    setActionErr(null);
    const r = await setSalonboardCredentialEnabled(row.shop_id, !row.enabled);
    setBusy(null);
    if (!r.ok) setActionErr(r.error ?? '更新に失敗しました');
    else await onReload();
  }

  async function remove() {
    if (!canEdit) return;
    if (!confirm(`「${row.shop_name}」のサロンボード認証情報を削除します。よろしいですか?`)) return;
    setBusy('delete');
    setActionErr(null);
    const r = await deleteSalonboardCredentials(row.shop_id);
    setBusy(null);
    if (!r.ok) setActionErr(r.error ?? '削除に失敗しました');
    else await onReload();
  }

  return (
    <div className="rounded-[12px] border border-hairline bg-white/90 p-3">
      <div className="flex items-start gap-2">
        <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-brand-light/60 text-brand-700">
          <Store className="h-3.5 w-3.5" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-[13px] font-semibold text-ink">{row.shop_name}</span>
            <span className="inline-flex shrink-0 items-center rounded-full bg-slate-100 px-1.5 py-0.5 text-[9px] font-semibold text-slate-600">
              {shopGenreLabel(row.shop_genre)}
            </span>
            {linked ? (
              row.enabled ? (
                <span className="inline-flex items-center gap-0.5 rounded-full bg-emerald-50 px-1.5 py-0.5 text-[9px] font-semibold text-emerald-700">
                  <ShieldCheck className="h-2.5 w-2.5" /> 連携中
                </span>
              ) : (
                <span className="inline-flex items-center gap-0.5 rounded-full bg-slate-100 px-1.5 py-0.5 text-[9px] font-semibold text-slate-600">
                  <ShieldOff className="h-2.5 w-2.5" /> 停止中
                </span>
              )
            ) : (
              <span className="inline-flex items-center gap-0.5 rounded-full bg-amber-50 px-1.5 py-0.5 text-[9px] font-semibold text-amber-700">
                <TriangleAlert className="h-2.5 w-2.5" /> 未設定
              </span>
            )}
          </div>
          {linked && (
            <div className="mt-1 text-[11px] text-ink-soft">
              ログイン ID: <code className="font-mono">{row.login_id ?? '—'}</code>
            </div>
          )}
          {linked && (
            <ChromeProfileField
              shopId={row.shop_id}
              current={row.chrome_profile_no}
              currentPort={row.chrome_debug_port}
              canEdit={canEdit}
              onSaved={onReload}
            />
          )}
          {linked && row.last_success_at && (
            <div className="mt-0.5 text-[10px] text-emerald-700">
              <CheckCircle2 className="mr-0.5 inline h-2.5 w-2.5" /> 最終成功:{' '}
              {new Date(row.last_success_at).toLocaleString('ja-JP')}
            </div>
          )}
          {(row.consecutive_failures ?? 0) > 0 && (
            <div className="mt-0.5 text-[10px] text-amber-700">
              <TriangleAlert className="mr-0.5 inline h-2.5 w-2.5" /> 連続失敗{' '}
              {row.consecutive_failures} 回 {row.last_error && `: ${row.last_error}`}
            </div>
          )}
          {row.blocked_until && new Date(row.blocked_until).getTime() > Date.now() && (
            <div className="mt-0.5 text-[10px] text-red-700">
              ブロック中: {new Date(row.blocked_until).toLocaleString('ja-JP')} まで
            </div>
          )}
        </div>
      </div>

      {/* 同期ステータスバー */}
      {syncStatus && syncStatus.state !== 'idle' && (
        <div
          className={
            'mt-2 rounded-[8px] px-2 py-1.5 text-[10px] ' +
            (syncStatus.state === 'running'
              ? 'bg-brand-light/60 text-brand-700'
              : syncStatus.state === 'success'
                ? 'bg-emerald-50 text-emerald-700'
                : 'bg-red-50 text-red-700')
          }
        >
          {syncStatus.state === 'running' && (
            <span className="inline-flex items-center gap-1">
              <Loader2 className="h-2.5 w-2.5 animate-spin" /> 同期中: {syncStatus.msg}
            </span>
          )}
          {syncStatus.state === 'success' && (
            <span className="inline-flex items-center gap-1">
              <CheckCircle2 className="h-2.5 w-2.5" /> 同期完了
              {syncStatus.summary ? ` (${syncStatus.summary})` : ''}
            </span>
          )}
          {syncStatus.state === 'failed' && (
            <span className="inline-flex items-center gap-1">
              <TriangleAlert className="h-2.5 w-2.5" /> 失敗: {syncStatus.error}
            </span>
          )}
        </div>
      )}

      <div className="mt-2 flex items-center gap-1.5">
        {canEdit && (
          <>
            <button
              type="button"
              onClick={onEdit}
              className="inline-flex items-center gap-1 rounded-[8px] border border-hairline bg-white px-2.5 py-1 text-[11px] font-semibold text-brand-700 hover:bg-brand-light/40"
            >
              <Pencil className="h-3 w-3" />
              {linked ? '編集' : '設定'}
            </button>
            {linked && (
              <button
                type="button"
                disabled={!ready || isRunning || !row.enabled}
                onClick={() => onSync()}
                className="inline-flex items-center gap-1 rounded-[8px] bg-brand-gradient px-2.5 py-1 text-[11px] font-semibold text-white shadow-brand-sm disabled:opacity-50"
                title={!row.enabled ? '停止中の店舗は同期できません' : '今すぐ同期 (バックグラウンド)'}
              >
                <PlayCircle className="h-3 w-3" /> 同期
              </button>
            )}
            {linked && (
              <button
                type="button"
                disabled={!ready || isRunning || !row.enabled}
                onClick={() => onSync({ showBrowser: true })}
                className="inline-flex items-center gap-1 rounded-[8px] border border-brand-300 bg-white px-2.5 py-1 text-[11px] font-semibold text-brand-700 hover:bg-brand-light/40 disabled:opacity-50"
                title="ブラウザを表示しながら同期 (デバッグ用)"
              >
                <PlayCircle className="h-3 w-3" /> 表示同期
              </button>
            )}
            {linked && (
              <button
                type="button"
                disabled={busy === 'enable'}
                onClick={() => void toggle()}
                className="inline-flex items-center gap-1 rounded-[8px] border border-hairline bg-white px-2.5 py-1 text-[11px] font-semibold text-ink-soft hover:bg-brand-light/40 disabled:opacity-50"
              >
                {row.enabled ? '停止' : '再開'}
              </button>
            )}
            {linked && (
              <button
                type="button"
                disabled={busy === 'delete'}
                onClick={() => void remove()}
                className="inline-flex items-center gap-1 rounded-[8px] border border-red-200 bg-red-50 px-2.5 py-1 text-[11px] font-semibold text-red-700 hover:bg-red-100 disabled:opacity-50"
              >
                <Trash2 className="h-3 w-3" /> 削除
              </button>
            )}
          </>
        )}
      </div>

      {/* 項目別の同期 (店舗カード内) */}
      {canEdit && linked && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <span className="text-[9px] font-bold uppercase tracking-wider text-muted">
            項目別
          </span>
          {(
            [
              { ch: 'bookings' as const, label: '予約', icon: <CalendarRange className="h-2.5 w-2.5" /> },
              { ch: 'staff' as const, label: 'スタッフ', icon: <Users className="h-2.5 w-2.5" /> },
              { ch: 'menus' as const, label: 'メニュー', icon: <BookOpen className="h-2.5 w-2.5" /> },
              // 美容室(hair)=スタイル / それ以外(エステ等)=フォトギャラリー を取得できる。
              // どちらも menus チャネルで取得され、画像付きで *_imports に保存される。
              ...(row.shop_genre === 'hair'
                ? [{ ch: 'menus' as const, label: 'スタイル', icon: <Scissors className="h-2.5 w-2.5" /> }]
                : [{ ch: 'menus' as const, label: 'フォトギャラリー', icon: <ImageIcon className="h-2.5 w-2.5" /> }]),
              { ch: 'coupons' as const, label: 'クーポン', icon: <Ticket className="h-2.5 w-2.5" /> },
              { ch: 'shifts' as const, label: 'シフト', icon: <CalendarClock className="h-2.5 w-2.5" /> },
              { ch: 'blog' as const, label: 'ブログ', icon: <Newspaper className="h-2.5 w-2.5" /> },
            ]
          ).map(({ ch, label, icon }) => (
            <span key={`${ch}:${label}`} className="inline-flex overflow-hidden rounded-[6px] border border-brand-200 bg-white">
              <button
                type="button"
                disabled={!ready || isRunning || !row.enabled}
                onClick={() => onSync({ channels: [ch] })}
                title={`${label}のみを同期`}
                className="inline-flex items-center gap-1 bg-brand-light/50 px-2 py-0.5 text-[10px] font-semibold text-brand-700 hover:bg-brand-light disabled:opacity-50"
              >
                {icon}
                {label}
              </button>
              <button
                type="button"
                disabled={!ready || isRunning || !row.enabled}
                onClick={() => onSync({ channels: [ch], showBrowser: true })}
                title={`${label}を表示しながら同期`}
                className="border-l border-brand-200 px-1 py-0.5 text-brand-700 hover:bg-brand-light/40 disabled:opacity-50"
              >
                <Eye className="h-2.5 w-2.5" />
              </button>
            </span>
          ))}
        </div>
      )}
      {actionErr && <p className="mt-2 text-[11px] text-red-700">{actionErr}</p>}
    </div>
  );
}

/**
 * 店舗ごとの Chrome プロファイル番号 + CDP ポート 入力欄。
 * 予約の書込/キャンセル/変更を、店舗ごとに「別プロファイル + 別ポート」の起動中
 * Chrome へ CDP 接続して実行する。空欄=Default/既定9222, 0=Default, N=Profile N。
 * 店舗ごとにポートを分けると完全並列に処理できる。RPC 経由で DB に書き戻す。
 */
function ChromeProfileField({
  shopId,
  current,
  currentPort,
  canEdit,
  onSaved,
}: {
  shopId: string;
  current: number | null;
  currentPort: number | null;
  canEdit: boolean;
  onSaved: () => Promise<void>;
}) {
  const [value, setValue] = useState<string>(current == null ? '' : String(current));
  const [portValue, setPortValue] = useState<string>(currentPort == null ? '' : String(currentPort));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const dirty =
    (current == null ? '' : String(current)) !== value.trim() ||
    (currentPort == null ? '' : String(currentPort)) !== portValue.trim();

  async function save() {
    if (!canEdit) return;
    const t = value.trim();
    let no: number | null;
    if (t === '') no = null;
    else {
      const n = Number(t);
      if (!Number.isInteger(n) || n < 0) { setErr('プロファイルは0以上の整数'); return; }
      no = n;
    }
    const pt = portValue.trim();
    let port: number | null;
    if (pt === '') port = null;
    else {
      const p = Number(pt);
      if (!Number.isInteger(p) || p < 1024 || p > 65535) { setErr('ポートは1024〜65535'); return; }
      port = p;
    }
    setBusy(true);
    setErr(null);
    const r = await setSalonboardChromeProfile(shopId, no, port);
    setBusy(false);
    if (!r.ok) setErr(r.error ?? '保存に失敗しました');
    else await onSaved();
  }

  return (
    <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-ink-soft">
      <span className="shrink-0">Chromeプロファイル:</span>
      <input
        type="number" min={0} inputMode="numeric"
        value={value} onChange={(e) => setValue(e.target.value)}
        placeholder="Default" disabled={!canEdit || busy}
        title="Chrome の Profile 番号 (0=Default, 1=Profile 1…)。空欄=Default。"
        className="w-14 rounded border border-hairline px-1.5 py-0.5 text-[11px] disabled:opacity-40"
      />
      <span className="shrink-0">ポート:</span>
      <input
        type="number" min={1024} max={65535} inputMode="numeric"
        value={portValue} onChange={(e) => setPortValue(e.target.value)}
        placeholder="9222" disabled={!canEdit || busy}
        title="この店舗用 Chrome の --remote-debugging-port。店舗ごとに別ポート=並列処理。空欄=9222。"
        className="w-16 rounded border border-hairline px-1.5 py-0.5 text-[11px] disabled:opacity-40"
      />
      <button
        onClick={save}
        disabled={!canEdit || busy || !dirty}
        className="rounded border border-brand-200 px-1.5 py-0.5 text-[10px] text-brand-700 hover:bg-brand-light/40 disabled:opacity-40"
      >
        保存
      </button>
      {err && <span className="text-[10px] text-red-600">{err}</span>}
    </div>
  );
}

export function EditModal({
  row,
  onClose,
  onSaved,
}: {
  row: CredentialOverviewRow;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [loginId, setLoginId] = useState(row.login_id ?? '');
  const [password, setPassword] = useState('');
  // パスワードは「入力ミスを目で確認したい」運用なのでデフォルトで平文表示
  const [showPassword, setShowPassword] = useState(true);
  const [baseUrl, setBaseUrl] = useState(row.base_url ?? 'https://salonboard.com/login/');
  // グループ店舗(1ログイン複数サロン)用の SalonBoard サロンID (H000...)。任意。
  const [salonId, setSalonId] = useState(row.salonboard_salon_id ?? '');
  const [pending, setPending] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [revealing, setRevealing] = useState(row.has_credential);
  const [revealError, setRevealError] = useState<string | null>(null);

  // 編集モードのとき、既存の login_id / password / base_url を RPC で取得して prefill。
  // パスワードは pgsodium で暗号化されているが reveal RPC で復号できる
  // (owner / shop_manager / admin / super_owner のみ)。
  useEffect(() => {
    if (!row.has_credential) {
      setRevealing(false);
      return;
    }
    let cancelled = false;
    void (async () => {
      const r = await revealSalonboardCredentials(row.shop_id);
      if (cancelled) return;
      if (r.ok) {
        setLoginId(r.loginId);
        setPassword(r.password);
        if (r.baseUrl) setBaseUrl(r.baseUrl);
        if (r.salonId) setSalonId(r.salonId);
      } else {
        setRevealError(r.error);
      }
      setRevealing(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [row.shop_id, row.has_credential]);

  async function save() {
    setErr(null);
    if (!loginId.trim()) {
      setErr('ログイン ID を入力してください');
      return;
    }
    if (!password.trim()) {
      setErr('パスワードを入力してください');
      return;
    }
    setPending(true);
    const r = await upsertSalonboardCredentials({
      shopId: row.shop_id,
      organizationId: row.organization_id,
      loginId: loginId.trim(),
      password,
      baseUrl: baseUrl.trim() || null,
      salonId: salonId.trim() || null,
    });
    setPending(false);
    if (!r.ok) {
      setErr(r.error);
      return;
    }
    await onSaved();
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <div
        role="dialog"
        className="w-full max-w-md rounded-2xl bg-white shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-hairline px-5 py-4">
          <div>
            <div className="text-[10px] uppercase tracking-wider text-muted">{row.organization_name}</div>
            <div className="text-[14px] font-bold text-ink">{row.shop_name}</div>
          </div>
          <button type="button" onClick={onClose} className="text-ink-soft hover:text-ink">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-3.5 px-5 py-4">
          <div>
            <label className="mb-1 block text-[11px] font-semibold text-ink-soft">サロンボード ログイン ID</label>
            <input
              type="text"
              autoComplete="off"
              value={loginId}
              onChange={(e) => setLoginId(e.target.value)}
              placeholder="例: CD12345"
              className="w-full rounded-[10px] border border-hairline bg-white px-3 py-2 text-[13px] outline-none focus:border-brand"
            />
          </div>
          <div>
            <label className="mb-1 block text-[11px] font-semibold text-ink-soft">パスワード</label>
            <div className="relative">
              <input
                type={showPassword ? 'text' : 'password'}
                autoComplete="off"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={revealing ? '既存パスワードを取得中…' : 'サロンボードのパスワード'}
                disabled={revealing}
                className="w-full rounded-[10px] border border-hairline bg-white px-3 py-2 pr-10 text-[13px] outline-none focus:border-brand disabled:bg-slate-50"
              />
              <button
                type="button"
                tabIndex={-1}
                onClick={() => setShowPassword((v) => !v)}
                className="absolute inset-y-0 right-0 flex items-center px-3 text-ink-soft hover:text-ink"
                title={showPassword ? 'パスワードを隠す' : 'パスワードを表示'}
              >
                {showPassword ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
              </button>
            </div>
            <p className="mt-1 text-[10px] text-ink-soft">
              {revealError
                ? `※ 既存パスワードを取得できませんでした (${revealError})。新しいパスワードを入力すれば上書きできます。`
                : '※ パスワードは Supabase 側で pgsodium により暗号化されます。'}
            </p>
          </div>
          <div>
            <label className="mb-1 block text-[11px] font-semibold text-ink-soft">ログイン URL (任意)</label>
            <input
              type="url"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder="https://salonboard.com/login/"
              className="w-full rounded-[10px] border border-hairline bg-white px-3 py-2 text-[13px] outline-none focus:border-brand"
            />
            <p className="mt-1 text-[10px] text-ink-soft">
              通常はデフォルトのままで OK。ステージング環境がある場合のみ変更してください。
            </p>
          </div>
          <div>
            <label className="mb-1 block text-[11px] font-semibold text-ink-soft">
              サロンID (グループ店舗のみ・任意)
            </label>
            <input
              type="text"
              autoComplete="off"
              value={salonId}
              onChange={(e) => setSalonId(e.target.value)}
              placeholder="例: H000650996"
              className="w-full rounded-[10px] border border-hairline bg-white px-3 py-2 font-mono text-[13px] outline-none focus:border-brand"
            />
            <p className="mt-1 text-[10px] text-ink-soft">
              1つのログインで複数サロンを管理している場合のみ入力してください。ログイン後の
              「サロン選択」画面で、このIDのサロンを自動で選びます。単一店舗なら空欄でOK。
            </p>
          </div>
          {err && (
            <div className="rounded-[10px] bg-red-50 px-3 py-2 text-[11px] text-red-700">{err}</div>
          )}
        </div>

        <div className="flex justify-end gap-2 border-t border-hairline px-5 py-3">
          <button
            type="button"
            onClick={onClose}
            disabled={pending}
            className="rounded-[10px] px-4 py-2 text-[12px] font-semibold text-ink-soft hover:text-ink disabled:opacity-50"
          >
            キャンセル
          </button>
          <button
            type="button"
            onClick={() => void save()}
            disabled={pending}
            className="inline-flex items-center gap-2 rounded-[10px] bg-brand-gradient px-4 py-2 text-[12px] font-semibold text-white shadow-brand-sm disabled:opacity-60"
          >
            {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
            {pending ? '保存中…' : row.has_credential ? '更新' : '登録'}
          </button>
        </div>
      </div>
    </div>
  );
}
