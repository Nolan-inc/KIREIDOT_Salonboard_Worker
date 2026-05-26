import { Bell, RefreshCw, Search } from 'lucide-react';
import { OrgSwitcher } from './OrgSwitcher';

export function Topbar({
  title,
  description,
}: {
  title: string;
  description?: string;
}) {
  return (
    <header className="app-drag flex h-[64px] shrink-0 items-center justify-between border-b border-hairline/60 bg-white/55 px-8 backdrop-blur-md">
      <div>
        <h1 className="font-serif text-[22px] font-bold leading-none tracking-tight text-ink">
          {title}
        </h1>
        {description && (
          <p className="mt-1 text-[12px] text-ink-soft">{description}</p>
        )}
      </div>
      <div className="app-no-drag flex items-center gap-2">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-faint" size={14} />
          <input
            type="search"
            placeholder="検索 (顧客、予約、スタッフ…)"
            className="h-9 w-64 rounded-[12px] border border-hairline bg-white/85 pl-9 pr-3 text-[13px] text-ink placeholder:text-muted-faint focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/20"
          />
        </div>
        <button
          type="button"
          className="inline-flex h-9 w-9 items-center justify-center rounded-full border border-hairline bg-white/80 text-brand-700 transition hover:bg-brand-light/70"
          aria-label="同期"
          title="サロンボードと同期"
        >
          <RefreshCw className="h-4 w-4" />
        </button>
        <button
          type="button"
          className="relative inline-flex h-9 w-9 items-center justify-center rounded-full border border-hairline bg-white/80 text-brand-700 transition hover:bg-brand-light/70"
          aria-label="通知"
        >
          <Bell className="h-4 w-4" />
          <span className="absolute right-1.5 top-1.5 h-1.5 w-1.5 rounded-full bg-brand" />
        </button>
        <OrgSwitcher />
      </div>
    </header>
  );
}
