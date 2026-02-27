import React from 'react';
import { X } from 'lucide-react';
import { cn } from '../../lib/utils';

export type SettingsShellVariant = 'modal' | 'page';

export type SettingsShellTab = {
  id: string;
  label: string;
  icon?: React.ReactNode;
  hidden?: boolean;
};

export function SettingsShell({
  variant,
  title,
  titleIcon,
  onClose,
  tabs,
  activeTab,
  onTabChange,
  children,
  footer,
}: {
  variant: SettingsShellVariant;
  title: React.ReactNode;
  titleIcon?: React.ReactNode;
  onClose?: () => void;
  tabs: SettingsShellTab[];
  activeTab: string;
  onTabChange: (tabId: string) => void;
  children: React.ReactNode;
  footer?: React.ReactNode;
}) {
  const safeOnClose = onClose || (() => {});

  return (
    <div
      className={cn(
        variant === 'modal'
          ? 'fixed inset-0 z-[60] bg-black/70 backdrop-blur-[2px] flex justify-end'
          : 'p-3 sm:p-6 max-w-[1600px] mx-auto h-full'
      )}
      onClick={variant === 'modal' ? safeOnClose : undefined}
    >
      <div
        className={cn(
          'bg-[#0d1117] shadow-2xl flex flex-col overflow-hidden',
          variant === 'modal'
            ? 'h-full w-full sm:w-[520px] border-l border-white/5'
            : 'w-full max-w-[1280px] mx-auto border border-slate-800 rounded-2xl min-h-[calc(100vh-160px)]'
        )}
        style={variant === 'modal' ? { animation: 'slideInRight 0.22s cubic-bezier(0.22,1,0.36,1)' } : undefined}
        onClick={variant === 'modal' ? (e) => e.stopPropagation() : undefined}
      >
        <div className="h-14 flex items-center justify-between px-5 border-b border-white/5 bg-[#111827] shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            {titleIcon ? <span className="shrink-0">{titleIcon}</span> : null}
            <span className="font-bold text-white text-base truncate">{title}</span>
          </div>
          {onClose ? (
            <button
              onClick={safeOnClose}
              className="p-2 rounded-lg text-slate-500 hover:text-white hover:bg-slate-800 transition-colors"
              title="Bağla"
            >
              <X className="w-5 h-5" />
            </button>
          ) : null}
        </div>

        <div className="flex border-b border-slate-800 bg-[#0d1117] shrink-0 overflow-x-auto custom-scrollbar">
          {tabs.filter((t) => !t.hidden).map((tab) => (
            <button
              key={tab.id}
              onClick={() => onTabChange(tab.id)}
              className={cn(
                'flex-1 min-w-[max-content] px-3 flex items-center justify-center gap-1.5 py-2.5 text-xs font-semibold transition-all border-b-2',
                activeTab === tab.id
                  ? 'border-blue-500 text-blue-300'
                  : 'border-transparent text-slate-500 hover:text-slate-300'
              )}
            >
              {tab.icon ? <span className="text-slate-400">{tab.icon}</span> : null}
              <span className="hidden sm:inline">{tab.label}</span>
            </button>
          ))}
        </div>

        <div className="flex-1 overflow-y-auto p-5">{children}</div>

        {footer ? (
          <div className="p-4 border-t border-white/5 bg-[#111827]/60 shrink-0 space-y-2">{footer}</div>
        ) : null}
      </div>

      <style>{`
        @keyframes slideInRight {
          from { transform: translateX(40px); opacity: 0; }
          to { transform: translateX(0); opacity: 1; }
        }
      `}</style>
    </div>
  );
}
