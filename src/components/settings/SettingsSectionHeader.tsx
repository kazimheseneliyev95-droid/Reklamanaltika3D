import React from 'react';
import { cn } from '../../lib/utils';

export function SettingsSectionHeader({
  title,
  description,
  actions,
  className,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex flex-col sm:flex-row items-start sm:items-start justify-between gap-3', className)}>
      <div className="min-w-0">
        <h2 className="text-sm sm:text-base font-bold text-white leading-tight">{title}</h2>
        {description ? (
          <p className="text-xs text-slate-400 mt-1 leading-relaxed">{description}</p>
        ) : null}
      </div>
      {actions ? <div className="w-full sm:w-auto shrink-0 flex items-center gap-2">{actions}</div> : null}
    </div>
  );
}
