import React from 'react';
import { cn } from '../../lib/utils';
import { Card, CardContent, CardHeader, CardTitle } from '../ui/Card';

export function HelpCallout({
  title,
  icon,
  children,
  className,
}: {
  title: React.ReactNode;
  icon?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <Card className={cn('bg-slate-950/40 border-slate-800', className)}>
      <CardHeader className="p-4">
        <CardTitle className="text-sm text-slate-100 flex items-center gap-2">
          {icon ? <span className="text-slate-400">{icon}</span> : null}
          {title}
        </CardTitle>
      </CardHeader>
      <CardContent className="p-4 pt-0 text-xs text-slate-400 leading-relaxed space-y-2">
        {children}
      </CardContent>
    </Card>
  );
}
