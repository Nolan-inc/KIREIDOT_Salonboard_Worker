import { useEffect, useMemo, useState } from 'react';
import { Plus, Send, ChevronLeft, ChevronRight, Loader2 } from 'lucide-react';
import { Card, CardBody, CardHeader } from '../components/Card';
import { useEffectiveScope } from '../lib/selection-context';
import { fetchShiftsForWeek, fetchStaffList, type ShiftRow, type StaffRow } from '../lib/data';

const HOURS = ['09', '10', '11', '12', '13', '14', '15', '16', '17', '18', '19', '20'];

function startOfWeek(d = new Date()): Date {
  const r = new Date(d);
  const day = (r.getDay() + 6) % 7;
  r.setDate(r.getDate() - day);
  r.setHours(0, 0, 0, 0);
  return r;
}

export function Shifts() {
  const scope = useEffectiveScope();
  const [loading, setLoading] = useState(true);
  const [shifts, setShifts] = useState<ShiftRow[]>([]);
  const [staff, setStaff] = useState<StaffRow[]>([]);

  useEffect(() => {
    if (!scope) return;
    let cancelled = false;
    setLoading(true);
    Promise.all([fetchShiftsForWeek(scope), fetchStaffList(scope)])
      .then(([s, st]) => {
        if (cancelled) return;
        setShifts(s);
        setStaff(st);
      })
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [scope?.shopId, scope?.organizationId]);

  const week = useMemo(() => {
    const start = startOfWeek();
    return Array.from({ length: 7 }, (_, i) => {
      const d = new Date(start);
      d.setDate(start.getDate() + i);
      return d;
    });
  }, []);

  const staffMap = useMemo(() => new Map(staff.map((s) => [s.id, s])), [staff]);

  // 日付ごとに shifts をグループ化
  const grouped = useMemo(() => {
    const map = new Map<string, ShiftRow[]>();
    for (const s of shifts) {
      const k = new Date(s.start_at).toDateString();
      const list = map.get(k) ?? [];
      list.push(s);
      map.set(k, list);
    }
    return map;
  }, [shifts]);

  return (
    <div className="flex flex-col gap-5 pt-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <button type="button" className="inline-flex h-9 w-9 items-center justify-center rounded-full border border-hairline bg-white/80 text-ink-soft hover:bg-brand-light/50">
            <ChevronLeft className="h-4 w-4" />
          </button>
          <div className="rounded-[12px] border border-hairline bg-white/85 px-4 py-2">
            <div className="text-[10px] uppercase tracking-wider text-muted">今週</div>
            <div className="font-serif text-[15px] font-bold text-ink">
              {week[0].toLocaleDateString('ja-JP', { month: 'numeric', day: 'numeric' })} -{' '}
              {week[6].toLocaleDateString('ja-JP', { month: 'numeric', day: 'numeric' })}
            </div>
          </div>
          <button type="button" className="inline-flex h-9 w-9 items-center justify-center rounded-full border border-hairline bg-white/80 text-ink-soft hover:bg-brand-light/50">
            <ChevronRight className="h-4 w-4" />
          </button>
        </div>
        <div className="flex items-center gap-2">
          <button type="button" className="inline-flex h-9 items-center gap-1.5 rounded-[12px] border border-hairline bg-white/80 px-4 text-[12px] font-semibold text-ink-soft hover:bg-brand-light/40">
            <Send className="h-3.5 w-3.5" /> サロンボードへ送信
          </button>
          <button type="button" className="inline-flex h-9 items-center gap-1.5 rounded-[12px] bg-brand-gradient px-4 text-[13px] font-semibold text-white shadow-brand-sm transition hover:shadow-brand">
            <Plus className="h-3.5 w-3.5" /> シフト追加
          </button>
        </div>
      </div>

      <Card className="overflow-hidden">
        <CardHeader title="今週のシフト" subtitle={loading ? '読み込み中…' : `${shifts.length} 件`} />
        <CardBody className="p-0">
          {loading ? (
            <div className="flex items-center gap-2 px-5 py-10 text-[13px] text-ink-soft">
              <Loader2 className="h-4 w-4 animate-spin" /> 読み込み中…
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[900px] text-[12px]">
                <thead>
                  <tr>
                    <th className="w-24 border-b border-hairline/60 bg-white/40 px-3 py-2 text-left text-[10px] uppercase tracking-wider text-muted">日付</th>
                    {HOURS.map((h) => (
                      <th key={h} className="border-b border-l border-hairline/60 bg-white/40 px-1 py-2 text-center text-[10px] font-semibold text-muted">
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {week.map((d) => {
                    const dayShifts = grouped.get(d.toDateString()) ?? [];
                    return (
                      <tr key={d.toISOString()} className="hover:bg-brand-light/20">
                        <td className="border-b border-hairline/60 px-3 py-2 align-top">
                          <div className="font-serif text-[15px] font-bold text-ink">
                            {d.toLocaleDateString('ja-JP', { weekday: 'short' })}
                          </div>
                          <div className="text-[10px] text-muted">
                            {d.toLocaleDateString('ja-JP', { month: 'numeric', day: 'numeric' })}
                          </div>
                          <span className="mt-1 inline-block rounded-full bg-emerald-100 px-1.5 py-0.5 text-[9px] font-bold text-emerald-700">
                            {dayShifts.length} 名
                          </span>
                        </td>
                        {HOURS.map((h) => {
                          const hourNum = parseInt(h, 10);
                          // この時間帯にいるシフトを当てはめる
                          const within = dayShifts.filter((s) => {
                            const sh = new Date(s.start_at).getHours();
                            const eh = new Date(s.end_at).getHours();
                            return sh <= hourNum && hourNum < eh;
                          });
                          return (
                            <td key={h} className="relative h-14 border-b border-l border-hairline/40 align-top">
                              {within.slice(0, 2).map((s, idx) => {
                                // 既存スタッフ DB と matched_staff_id 経由でリンクできれば使い、
                                // 取れなければ salonboard 由来の staff_name を表示。
                                const stf = staffMap.get(s.staff_id);
                                const label =
                                  stf?.full_name ?? s.staff_name ?? '?';
                                const off = !!s.is_off || !!s.is_requested_off;
                                return (
                                  <div
                                    key={s.id}
                                    className={
                                      off
                                        ? 'absolute inset-x-1 rounded-[6px] bg-amber-200 px-1 py-0.5 text-[9px] font-semibold text-amber-900'
                                        : 'absolute inset-x-1 rounded-[6px] bg-brand-gradient px-1 py-0.5 text-[9px] font-semibold text-white shadow-brand-sm'
                                    }
                                    style={{ top: 4 + idx * 22 }}
                                    title={off ? '休み' : `${label} 出勤`}
                                  >
                                    {(label || '').slice(0, 4)}
                                  </div>
                                );
                              })}
                            </td>
                          );
                        })}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardBody className="flex flex-wrap items-center gap-4 text-[11px] text-ink-soft">
          <span className="inline-flex items-center gap-1.5">
            <span className="inline-block h-3 w-6 rounded-[3px] bg-brand-gradient" />
            出勤
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="inline-block h-3 w-6 rounded-[3px] bg-amber-300" />
            希望休
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="inline-block h-3 w-6 rounded-[3px] bg-hairline" />
            未登録
          </span>
          <span className="ml-auto">登録対象スタッフ: {staff.length} 名</span>
        </CardBody>
      </Card>
    </div>
  );
}
