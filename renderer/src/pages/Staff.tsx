import { useEffect, useState } from 'react';
import { Plus, Loader2 } from 'lucide-react';
import { Card } from '../components/Card';
import { useEffectiveScope } from '../lib/selection-context';
import { fetchStaffList, type StaffRow } from '../lib/data';

const ROLE_LABELS: Record<string, string> = {
  staff: 'スタイリスト',
  shop_manager: '店長',
  owner: 'オーナー',
  admin: '管理者',
  super_owner: '統括',
};

export function Staff() {
  const scope = useEffectiveScope();
  const [loading, setLoading] = useState(true);
  const [staff, setStaff] = useState<StaffRow[]>([]);

  useEffect(() => {
    if (!scope) return;
    let cancelled = false;
    setLoading(true);
    fetchStaffList(scope)
      .then((data) => !cancelled && setStaff(data))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [scope?.shopId, scope?.organizationId]);

  return (
    <div className="flex flex-col gap-5 pt-4">
      <div className="flex items-center justify-between">
        <p className="text-[13px] text-ink-soft">
          {loading ? '読み込み中…' : `全 ${staff.length} 名`}
        </p>
        <div className="flex items-center gap-2">
          <button type="button" className="inline-flex h-9 items-center gap-1.5 rounded-[12px] border border-hairline bg-white/80 px-4 text-[12px] font-semibold text-ink-soft hover:bg-brand-light/40">
            サロンボードから取得
          </button>
          <button type="button" className="inline-flex h-9 items-center gap-1.5 rounded-[12px] bg-brand-gradient px-4 text-[13px] font-semibold text-white shadow-brand-sm transition hover:shadow-brand">
            <Plus className="h-3.5 w-3.5" /> スタッフ追加
          </button>
        </div>
      </div>

      {loading ? (
        <Card>
          <div className="flex items-center gap-2 px-5 py-10 text-[13px] text-ink-soft">
            <Loader2 className="h-4 w-4 animate-spin" /> 読み込み中…
          </div>
        </Card>
      ) : staff.length === 0 ? (
        <Card>
          <div className="px-5 py-10 text-center text-[13px] text-ink-soft">
            登録されているスタッフがありません。
          </div>
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {staff.map((s, i) => (
            <Card key={s.id} className="overflow-hidden">
              <div className="relative h-20 bg-gradient-to-br from-brand-200/70 to-brand-50">
                <div aria-hidden className="absolute -right-6 -top-6 h-24 w-24 rounded-full bg-white/40 blur-xl" />
              </div>
              <div className="relative px-5 pb-5">
                <div
                  className="absolute -top-8 left-5 flex h-14 w-14 items-center justify-center overflow-hidden rounded-full border-4 border-white bg-brand-gradient text-white shadow-card"
                  style={{ filter: `hue-rotate(${i * 6}deg)` }}
                >
                  {s.icon_url ? (
                    <img src={s.icon_url} alt={s.full_name} className="h-full w-full object-cover" />
                  ) : (
                    <span className="font-serif text-[18px] font-bold">{s.full_name.slice(0, 1)}</span>
                  )}
                </div>
                <div className="pt-10">
                  <div className="flex items-center justify-between">
                    <div className="min-w-0 flex-1">
                      <h3 className="truncate font-serif text-[16px] font-bold text-ink">
                        {s.full_name}
                      </h3>
                      <p className="text-[11px] text-ink-soft">
                        {s.position ?? ROLE_LABELS[s.role ?? ''] ?? 'スタッフ'}
                      </p>
                    </div>
                    {s.external_id && (
                      <span className="inline-flex items-center gap-1 rounded-full bg-brand-light/60 px-2 py-0.5 text-[10px] font-mono font-bold text-brand-700">
                        {s.external_id}
                      </span>
                    )}
                  </div>

                  {s.catch_phrase && (
                    <p className="mt-2 line-clamp-2 text-[12px] text-ink-soft">
                      {s.catch_phrase}
                    </p>
                  )}

                  {s.bio && (
                    <p className="mt-1 line-clamp-3 text-[11px] text-muted">{s.bio}</p>
                  )}
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

