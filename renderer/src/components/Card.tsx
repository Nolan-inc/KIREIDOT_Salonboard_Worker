import type { ReactNode } from 'react';
import { cn } from '../lib/cn';

export function Card({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'rounded-card border border-hairline/60 bg-card shadow-card',
        className,
      )}
    >
      {children}
    </div>
  );
}

export function CardBody({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return <div className={cn('p-5', className)}>{children}</div>;
}

export function CardHeader({
  title,
  subtitle,
  action,
}: {
  title: string;
  subtitle?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-3 border-b border-hairline/60 px-5 py-4">
      <div>
        <h3 className="font-serif text-[16px] font-bold text-ink">{title}</h3>
        {subtitle && (
          <p className="mt-0.5 text-[12px] text-ink-soft">{subtitle}</p>
        )}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}

export function SectionTitle({
  children,
  icon,
}: {
  children: ReactNode;
  icon?: ReactNode;
}) {
  return (
    <h2 className="mb-3 inline-flex items-center gap-2 text-[12px] font-bold uppercase tracking-[0.18em] text-ink-soft">
      {icon && (
        <span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-brand-100 text-brand-700">
          {icon}
        </span>
      )}
      <span>{children}</span>
    </h2>
  );
}
