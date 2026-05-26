import type { ReactNode } from 'react';
import { Sidebar } from './Sidebar';
import { Topbar } from './Topbar';
import { SetupStatusBanner } from './SetupStatusBanner';
import type { NavKey } from '../lib/nav';
import { NAV_ITEMS } from '../lib/nav';

export function AppShell({
  active,
  onChange,
  children,
}: {
  active: NavKey;
  onChange: (k: NavKey) => void;
  children: ReactNode;
}) {
  const current = NAV_ITEMS.find((n) => n.key === active);
  return (
    <div className="relative flex h-screen overflow-hidden">
      {/* オーロラ背景 */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 -z-10 bg-desk-aurora opacity-70"
      />
      <Sidebar active={active} onChange={onChange} />
      <main className="relative flex h-full flex-1 flex-col overflow-hidden">
        <Topbar
          title={current?.label ?? ''}
          description={current?.description ?? ''}
        />
        {/* device 設定不備など重要な状態は最上部のバナーで案内する (sync-controller の preflight 結果) */}
        <SetupStatusBanner />
        <div className="flex-1 overflow-y-auto px-8 pb-12 pt-2">{children}</div>
      </main>
    </div>
  );
}
