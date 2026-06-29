import { useEffect, useMemo, useState } from 'react';
import { Loader2, RefreshCcw, ScrollText, Activity } from 'lucide-react';
import { Card, CardBody, CardHeader } from '../components/Card';
import { useAuth } from '../lib/auth-context';
import { useSelection } from '../lib/selection-context';
import {
  fetchExecutionLogs,
  fetchActiveQueue,
  type ExecutionLogRow,
} from '../lib/data';

// 現在のキューを自動更新する間隔(ms)。
const QUEUE_POLL_MS = 5000;

// ISO時刻から「何分/秒前か」を出す。
function ago(iso: string | null): string {
  if (!iso) return '—';
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 0) return 'まもなく';
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}秒前`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}分前`;
  const hr = Math.floor(min / 60);
  return `${hr}時間${min % 60}分前`;
}

// job_type を「何をしようとしたか」の日本語に変換する。
const JOB_LABEL: Record<string, string> = {
  fetch_bookings: '予約の取得',
  fetch_sales: '売上の取得',
  push_booking: '予約の登録/変更',
  cancel_booking: '予約のキャンセル',
  push_shifts: 'シフトの反映',
  push_blog: 'ブログの投稿',
  delete_blog: 'ブログの削除',
  push_photo_gallery: 'フォトギャラリーの投稿',
  delete_photo_gallery: 'フォトギャラリーの削除',
  push_review_reply: '口コミ返信の投稿',
  fetch_shift_patterns: '勤務パターンの取得',
  fetch_staff: 'スタッフの取得',
  fetch_equipment: '設備の取得',
  fetch_reviews: '口コミの取得',
  fetch_blog: 'ブログの取得',
};

function jobLabel(jobType: string): string {
  return JOB_LABEL[jobType] ?? jobType;
}

// status を日本語+色に変換。
function statusMeta(status: string): { label: string; className: string } {
  switch (status) {
    case 'succeeded':
      return { label: '成功', className: 'text-emerald-600' };
    case 'failed':
      return { label: '失敗', className: 'text-red-600' };
    case 'running':
      return { label: '実行中', className: 'text-blue-600' };
    case 'queued':
      return { label: '待機中', className: 'text-amber-600' };
    case 'cancelled':
      return { label: 'スキップ', className: 'text-ink-soft' };
    default:
      return { label: status, className: 'text-ink-soft' };
  }
}

function fmtTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString('ja-JP', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  } catch {
    return iso;
  }
}

export function ExecutionLogs() {
  const auth = useAuth();
  const { selectedOrgId } = useSelection();
  const [loading, setLoading] = useState(true);
  const [rows, setRows] = useState<ExecutionLogRow[]>([]);
  const [queue, setQueue] = useState<ExecutionLogRow[]>([]);
  const [reloadKey, setReloadKey] = useState(0);
  // 経過時間(○分前)を再描画するためのティック。
  const [, setTick] = useState(0);

  const role = auth.status === 'signed-in' ? auth.scope.role : 'user';
  const isGlobal = role === 'super_owner' || role === 'admin';
  const orgFilter = isGlobal ? selectedOrgId ?? null : null;

  // 現在のキュー(running/queued)を数秒ごとにポーリングして自動更新。
  useEffect(() => {
    if (auth.status !== 'signed-in') return;
    let cancelled = false;
    const load = () => {
      fetchActiveQueue({ orgId: orgFilter }).then((data) => {
        if (!cancelled) setQueue(data);
      });
    };
    load();
    const timer = setInterval(load, QUEUE_POLL_MS);
    // ○分前表示を1秒ごとに更新。
    const tickTimer = setInterval(() => setTick((t) => t + 1), 1000);
    return () => {
      cancelled = true;
      clearInterval(timer);
      clearInterval(tickTimer);
    };
  }, [auth.status, orgFilter, reloadKey]);

  useEffect(() => {
    if (auth.status !== 'signed-in') return;
    let cancelled = false;
    setLoading(true);
    // 全社が見えるロール(super_owner/admin)は会社で絞らず全件、
    // それ以外は RLS で自組織に限定される(orgFilter を渡しても二重に効くだけ)。
    fetchExecutionLogs({ orgId: orgFilter, limit: 500 })
      .then((data) => {
        if (!cancelled) setRows(data);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [auth.status, orgFilter, reloadKey]);

  // 会社ごとにグループ化 (会社名でソート)。
  const groups = useMemo(() => {
    const map = new Map<string, { orgName: string; rows: ExecutionLogRow[] }>();
    for (const r of rows) {
      const key = r.organizationId ?? '(なし)';
      if (!map.has(key)) map.set(key, { orgName: r.organizationName, rows: [] });
      map.get(key)!.rows.push(r);
    }
    return Array.from(map.entries())
      .map(([orgId, v]) => ({ orgId, ...v }))
      .sort((a, b) => a.orgName.localeCompare(b.orgName, 'ja'));
  }, [rows]);

  return (
    <div className="flex flex-col gap-5 pt-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="font-serif text-[18px] font-bold text-ink">実行ログ</h2>
          <p className="mt-0.5 text-[12px] text-ink-soft">
            SalonBoard 連携の実行履歴を会社ごとに表示します（成功・失敗とも全件）
          </p>
        </div>
        <button
          type="button"
          onClick={() => setReloadKey((k) => k + 1)}
          disabled={loading}
          className="inline-flex items-center gap-1.5 rounded-[10px] border border-hairline bg-white px-3 py-1.5 text-[11px] font-semibold text-ink-soft hover:bg-brand-light/40 disabled:opacity-50"
        >
          <RefreshCcw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} /> 再読込
        </button>
      </div>

      {/* 現在のキュー (実行中/待機中) — 数秒ごとに自動更新 */}
      <Card className="overflow-hidden border-brand-300/60">
        <CardHeader
          title="現在のキュー"
          subtitle={`実行中・待機中のジョブ ${queue.length} 件（${QUEUE_POLL_MS / 1000}秒ごとに自動更新）`}
          action={
            <span className="inline-flex items-center gap-1.5 text-[11px] text-emerald-600">
              <span className="relative flex h-2 w-2">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
              </span>
              自動更新中
            </span>
          }
        />
        <CardBody className="p-0">
          {queue.length === 0 ? (
            <div className="flex items-center gap-2 px-5 py-6 text-[12px] text-ink-soft">
              <Activity className="h-4 w-4 text-ink-soft/50" />
              現在実行中・待機中のジョブはありません。
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-[12px]">
                <thead className="bg-brand-light/30 text-ink-soft">
                  <tr>
                    <th className="whitespace-nowrap px-4 py-2.5 text-left font-semibold">状態</th>
                    <th className="px-4 py-2.5 text-left font-semibold">会社</th>
                    <th className="px-4 py-2.5 text-left font-semibold">店舗</th>
                    <th className="px-4 py-2.5 text-left font-semibold">内容</th>
                    <th className="whitespace-nowrap px-4 py-2.5 text-left font-semibold">経過</th>
                    <th className="whitespace-nowrap px-4 py-2.5 text-left font-semibold">処理機</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-hairline">
                  {queue.map((r) => {
                    const sm = statusMeta(r.status);
                    const isRunning = r.status === 'running';
                    return (
                      <tr key={r.id} className="hover:bg-brand-light/10">
                        <td className="whitespace-nowrap px-4 py-2.5">
                          <span className={`inline-flex items-center gap-1 font-semibold ${sm.className}`}>
                            {isRunning && <Loader2 className="h-3 w-3 animate-spin" />}
                            {sm.label}
                          </span>
                          {r.attempts > 1 && (
                            <span className="ml-1 text-[10px] text-ink-soft">({r.attempts}回目)</span>
                          )}
                        </td>
                        <td className="px-4 py-2.5 text-ink-soft">{r.organizationName}</td>
                        <td className="px-4 py-2.5 text-ink-soft">{r.shopName}</td>
                        <td className="px-4 py-2.5 font-semibold text-ink">{jobLabel(r.jobType)}</td>
                        <td className="whitespace-nowrap px-4 py-2.5 tabular-nums text-ink-soft">
                          {isRunning ? ago(r.lockedAt) : `予定 ${ago(r.runAt)}`}
                        </td>
                        <td className="whitespace-nowrap px-4 py-2.5 text-[11px] text-ink-soft">
                          {r.lockedBy ?? '—'}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardBody>
      </Card>

      {/* 実行履歴 (全件) */}
      {loading ? (
        <Card>
          <div className="flex items-center gap-2 px-5 py-10 text-[13px] text-ink-soft">
            <Loader2 className="h-4 w-4 animate-spin" /> 読み込み中…
          </div>
        </Card>
      ) : rows.length === 0 ? (
        <Card>
          <CardBody className="flex flex-col items-center gap-2 py-12 text-center text-[12px] text-ink-soft">
            <ScrollText className="h-6 w-6 text-ink-soft/50" />
            実行ログがありません。
          </CardBody>
        </Card>
      ) : (
        groups.map((g) => (
          <Card key={g.orgId} className="overflow-hidden">
            <CardHeader title={g.orgName} subtitle={`実行ログ ${g.rows.length} 件`} />
            <CardBody className="overflow-x-auto p-0">
              <table className="w-full text-[12px]">
                <thead className="bg-brand-light/30 text-ink-soft">
                  <tr>
                    <th className="whitespace-nowrap px-4 py-2.5 text-left font-semibold">
                      実行日時
                    </th>
                    <th className="px-4 py-2.5 text-left font-semibold">内容</th>
                    <th className="whitespace-nowrap px-4 py-2.5 text-left font-semibold">
                      店舗
                    </th>
                    <th className="whitespace-nowrap px-4 py-2.5 text-left font-semibold">
                      結果
                    </th>
                    <th className="px-4 py-2.5 text-left font-semibold">詳細・エラー</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-hairline">
                  {g.rows.map((r) => {
                    const sm = statusMeta(r.status);
                    const detail =
                      r.status === 'failed'
                        ? r.error
                        : r.resultSummary || (r.status === 'succeeded' ? '正常終了' : r.error);
                    return (
                      <tr key={r.id} className="align-top hover:bg-brand-light/10">
                        <td className="whitespace-nowrap px-4 py-2.5 tabular-nums text-ink-soft">
                          {fmtTime(r.createdAt)}
                        </td>
                        <td className="px-4 py-2.5 font-semibold text-ink">
                          {jobLabel(r.jobType)}
                        </td>
                        <td className="whitespace-nowrap px-4 py-2.5 text-ink-soft">
                          {r.shopName}
                        </td>
                        <td className="whitespace-nowrap px-4 py-2.5">
                          <span className={`font-semibold ${sm.className}`}>{sm.label}</span>
                          {r.attempts > 1 && (
                            <span className="ml-1 text-[10px] text-ink-soft">
                              ({r.attempts}回試行)
                            </span>
                          )}
                        </td>
                        <td className="px-4 py-2.5">
                          <span
                            className={`block max-w-[420px] whitespace-pre-wrap break-words ${
                              r.status === 'failed' ? 'text-red-600' : 'text-ink-soft'
                            }`}
                          >
                            {detail || '—'}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </CardBody>
          </Card>
        ))
      )}
    </div>
  );
}
