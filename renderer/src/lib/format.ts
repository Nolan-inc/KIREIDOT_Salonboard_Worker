export function formatYen(n: number | null | undefined): string {
  if (n == null) return '¥0';
  return `¥${Math.round(n).toLocaleString('ja-JP')}`;
}

export function formatTime(iso: string | null | undefined): string {
  if (!iso) return '--:--';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '--:--';
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '-';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '-';
  return d.toLocaleDateString('ja-JP', { month: 'numeric', day: 'numeric', weekday: 'short' });
}

export function bookingStatusJp(status: string): { label: string; cls: string } {
  switch (status) {
    case 'confirmed':
      return { label: '確定', cls: 'bg-emerald-100 text-emerald-700' };
    case 'completed':
      return { label: '完了', cls: 'bg-brand-100 text-brand-700' };
    case 'cancelled':
      return { label: 'キャンセル', cls: 'bg-rose-100 text-rose-700' };
    case 'pending':
      return { label: '仮押え', cls: 'bg-amber-100 text-amber-700' };
    case 'no_show':
      return { label: '無断', cls: 'bg-zinc-200 text-zinc-700' };
    default:
      return { label: status, cls: 'bg-zinc-100 text-zinc-700' };
  }
}

export function postStatusJp(status: string | null): { label: string; cls: string } {
  switch (status) {
    case 'published':
      return { label: '公開中', cls: 'bg-emerald-100 text-emerald-700' };
    case 'scheduled':
      return { label: '予約投稿', cls: 'bg-sky-100 text-sky-700' };
    case 'draft':
      return { label: '下書き', cls: 'bg-amber-100 text-amber-700' };
    default:
      return { label: status ?? '-', cls: 'bg-zinc-100 text-zinc-700' };
  }
}
