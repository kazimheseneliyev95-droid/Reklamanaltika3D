import React from 'react';
import { cn } from '../../lib/utils';

export function SettingsGrid({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn('grid grid-cols-1 lg:grid-cols-12 gap-4 lg:gap-5', className)}
      {...props}
    />
  );
}

export function SettingsMain({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('lg:col-span-8 space-y-4', className)} {...props} />;
}

export function SettingsAside({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('lg:col-span-4 space-y-4', className)} {...props} />;
}
