import { useEffect, useState } from 'react';
import { Loader2, RefreshCcw, Bed } from 'lucide-react';
import { Card } from '../components/Card';
import { useEffectiveScope } from '../lib/selection-context';
import { useSyncController } from '../lib/sync-controller';
import { fetchEquipmentList, type EquipmentRow } from '../lib/data';

export function Equipment() {
  const scope = useEffectiveScope();
  const sync = useSyncController();
  const [loading, setLoading] = useState(true);
  const [equipment, setEquipment] = useState<EquipmentRow[]>([]);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    if (!scope) return;
    let cancelled = false;
    setLoading(true);
    fetchEquipmentList(scope)
      .then((data) => !cancelled && setEquipment(data))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [scope?.shopId, scope?.organizationId, reloadKey]);

  const canSync = !!scope?.shopId && sync.ready && !sync.isRunning;
  async function syncEquipment() {
    if (!scope?.shopId) return;
    await sync.syncShops([scope.shopId], ['equipment']);
    setTimeout(() => setReloadKey((k) => k + 1), 1500);
  }

  return (
    <div className="flex flex-col gap-5 pt-4">
      <div className="flex items-center justify-between">
        <p className="text-[13px] text-ink-soft">
          {loading
            ? '読み込み中…'
            : `SalonBoard から取得した設備 ${equipment.length} 件`}
        </p>
        <button
          type="button"
          onClick={syncEquipment}
          disabled={!canSync}
          title={scope?.shopId ? 'SalonBoard から設備を取得' : '先に店舗を選択してください'}
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

      {loading ? (
        <Card>
          <div className="flex items-center gap-2 px-5 py-10 text-[13px] text-ink-soft">
            <Loader2 className="h-4 w-4 animate-spin" /> 読み込み中…
          </div>
        </Card>
      ) : equipment.length === 0 ? (
        <Card>
          <div className="px-5 py-10 text-center text-[13px] text-ink-soft">
            設備がありません。
            <br />
            「サロンボードから取得」を押すと SalonBoard の設備設定（ベッド/席）を取り込めます。
          </div>
        </Card>
      ) : (
        <Card className="overflow-hidden">
          <table className="w-full text-[13px]">
            <thead className="bg-brand-light/30 text-ink-soft">
              <tr>
                <th className="px-5 py-3 text-left font-semibold">設備名</th>
                <th className="px-3 py-3 text-left font-semibold w-24">受付可能数</th>
                <th className="px-3 py-3 text-left font-semibold w-24">振り分け順</th>
                <th className="px-3 py-3 text-left font-semibold w-32">KIREIDOT紐付け</th>
                <th className="px-3 py-3 text-left font-semibold w-36">SB設備ID</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-hairline">
              {equipment.map((e) => (
                <tr key={e.id} className="hover:bg-brand-light/10">
                  <td className="px-5 py-3 font-semibold text-ink">
                    <span className="inline-flex items-center gap-1.5">
                      <Bed className="h-3.5 w-3.5 text-brand-500" /> {e.name}
                    </span>
                  </td>
                  <td className="px-3 py-3 text-ink-soft">{e.max_rsv_num ?? '-'}</td>
                  <td className="px-3 py-3 text-ink-soft">{e.priority ?? '-'}</td>
                  <td className="px-3 py-3">
                    {e.matched_resource_id ? (
                      <span className="text-emerald-600 font-medium">● 紐付け済み</span>
                    ) : (
                      <span className="text-amber-600">未紐付け</span>
                    )}
                  </td>
                  <td className="px-3 py-3 font-mono text-[11px] text-muted">{e.external_id}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}
