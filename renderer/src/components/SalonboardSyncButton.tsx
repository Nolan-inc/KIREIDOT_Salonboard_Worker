import { useState, type ReactNode } from 'react';
import { Loader2 } from 'lucide-react';
import { useAuth } from '../lib/auth-context';
import {
  defaultApiUrl,
  runLocalSalonboardSync,
  type SyncTargets,
} from '../lib/salonboard';

type Props = {
  children: ReactNode;
  className: string;
  targets: Partial<SyncTargets>;
  onDone?: () => void;
};

export function SalonboardSyncButton({ children, className, targets, onDone }: Props) {
  const auth = useAuth();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleClick() {
    if (auth.status !== 'signed-in') return;
    if (!auth.scope.shopId) {
      setError('複数会社/店舗を扱う場合は設定画面で店舗を選択して同期してください。');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const selectedTargets: SyncTargets = {
        bookings: false,
        staff: false,
        shifts: false,
        blogs: false,
        ...targets,
      };
      const result = await runLocalSalonboardSync({
        apiUrl: defaultApiUrl(),
        accessToken: auth.session.access_token,
        shopId: auth.scope.shopId,
        targets: selectedTargets,
        showBrowser: false,
      });
      if (!result.ok) {
        const failed = Object.values(result.results).find((r) => r?.error);
        throw new Error(failed?.error ?? '同期に失敗しました');
      }
      onDone?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  return (
    <span className="inline-flex flex-col items-end gap-1">
      <button
        type="button"
        onClick={handleClick}
        disabled={loading || auth.status !== 'signed-in'}
        className={className}
      >
        {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
        {children}
      </button>
      {error && <span className="max-w-80 text-right text-[10px] font-semibold text-red-700">{error}</span>}
    </span>
  );
}
