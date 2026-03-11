import { Link, useLocation } from 'react-router-dom';
import { LayoutDashboard, ShieldCheck, LogOut, BarChart3, Settings, Timer, PieChart } from 'lucide-react';
import { useAppStore } from '../context/Store';
import { cn } from '../lib/utils';
import { NotificationBell } from './NotificationBell';

export default function Layout({ children }: { children: React.ReactNode }) {
  const location = useLocation();
  const { logout, currentUser } = useAppStore();
  const canViewStats = currentUser?.permissions?.view_stats !== false;

  const isPathMatch = (path: string) => {
    if (path === '/') return location.pathname === '/';
    return location.pathname === path || location.pathname.startsWith(path + '/');
  };

  const navItems = currentUser?.role === 'superadmin'
    ? [
      { name: 'Global İdarəetmə', path: '/superadmin', icon: <ShieldCheck className="w-5 h-5" /> }
    ]
    : [
      { name: 'CRM (Classic)', path: '/crm', icon: <LayoutDashboard className="w-5 h-5" /> },
      ...(canViewStats ? [
        { name: 'Dashboard', path: '/dashboard', icon: <PieChart className="w-5 h-5" /> },
        { name: 'Analitika', path: '/analytics', icon: <BarChart3 className="w-5 h-5" /> },
        { name: 'Cavab Sureleri', path: '/analytics/response-times', icon: <Timer className="w-5 h-5" /> },
      ] : []),
      { name: 'Ayarlar', path: '/settings', icon: <Settings className="w-5 h-5" /> },
    ];

  // Mark only the most specific matching route as active
  const activePath = (navItems || [])
    .filter((i) => isPathMatch(i.path))
    .sort((a, b) => b.path.length - a.path.length)[0]?.path;

  return (
    <div className="min-h-[100dvh] bg-slate-950 text-slate-50 flex flex-col md:flex-row">
      {/* Mobile Top Bar (Minimal) */}
      <div className="mobile-topbar md:hidden flex items-center justify-between px-3 py-3 bg-slate-900 border-b border-slate-800 sticky top-0 z-40" style={{ paddingTop: 'max(0.75rem, env(safe-area-inset-top))' }}>
        <div className="min-w-0">
          <h1 className="text-lg font-bold bg-gradient-to-r from-blue-400 to-purple-400 bg-clip-text text-transparent leading-tight">
            ReklamAnalitika
          </h1>
          {currentUser?.display_name && (
            <p className="text-[10px] text-slate-500 truncate max-w-[70vw]">{currentUser.display_name}</p>
          )}
        </div>
        {currentUser?.role !== 'superadmin' && (
          <div className="flex items-center gap-1">
            <NotificationBell className="text-slate-200" />
            <button
              onClick={logout}
              className="p-2 text-rose-400 hover:text-rose-300"
              title="Çıxış"
            >
              <LogOut className="w-5 h-5" />
            </button>
          </div>
        )}
      </div>

      {/* Mobile Bottom Navigation (PWA style) */}
      <nav className="mobile-bottom-nav md:hidden fixed bottom-0 inset-x-0 h-[74px] bg-slate-900/98 border-t border-slate-800 z-50 flex items-stretch justify-around backdrop-blur-xl" style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}>
        {navItems.map((item) => {
          const isActive = activePath === item.path;
          return (
            <Link
              key={item.path}
              to={item.path}
              className={cn(
                "flex min-w-0 flex-col items-center justify-center w-full px-1 py-2 gap-1 transition-colors",
                isActive ? "text-blue-400" : "text-slate-500 hover:text-slate-300"
              )}
            >
              <div className={cn("p-1.5 rounded-full", isActive && "bg-blue-600/20")}>
                {item.icon}
              </div>
              <span className="text-[10px] leading-tight font-medium text-center max-w-[72px] truncate">{item.name}</span>
            </Link>
          );
        })}
        {currentUser?.role === 'superadmin' && (
          <button
            onClick={logout}
            className="flex min-w-0 flex-col items-center justify-center w-full px-1 py-2 gap-1 transition-colors text-rose-500 hover:text-rose-400"
          >
            <div className="p-1.5 rounded-full">
              <LogOut className="w-5 h-5" />
            </div>
            <span className="text-[10px] leading-tight font-medium text-center max-w-[72px] truncate">Çıxış</span>
          </button>
        )}
      </nav>

      {/* Desktop Sidebar */}
      <aside className="hidden md:flex md:w-64 bg-slate-900 border-r border-slate-800 flex-shrink-0 flex-col">
        <div className="p-6 border-b border-slate-800">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h1 className="text-xl font-bold bg-gradient-to-r from-blue-400 to-purple-400 bg-clip-text text-transparent">
                ReklamAnalitika
              </h1>
              <p className="text-xs text-slate-500 mt-1 truncate">{currentUser?.display_name || 'Ads & CRM Suite'}</p>
            </div>
            {currentUser?.role !== 'superadmin' ? (
              <NotificationBell className="text-slate-200" />
            ) : null}
          </div>
        </div>

        <nav className="p-4 space-y-2 flex-1">
          {navItems.map((item) => {
            const isActive = activePath === item.path;
            return (
              <Link
                key={item.path}
                to={item.path}
                className={cn(
                  "flex items-center gap-3 px-4 py-3 rounded-lg text-sm font-medium transition-colors",
                  isActive
                    ? "bg-blue-600 text-white shadow-lg shadow-blue-900/20"
                    : "text-slate-400 hover:text-white hover:bg-slate-800"
                )}
              >
                {item.icon}
                {item.name}
              </Link>
            );
          })}
        </nav>

        <div className="p-4 border-t border-slate-800">
          <div className="flex flex-col gap-3">
            <button
              onClick={logout}
              className="flex items-center gap-2 px-3 py-2 text-sm font-medium text-rose-400 hover:text-rose-300 hover:bg-rose-500/10 rounded-lg transition-colors w-full"
            >
              <LogOut className="w-4 h-4" />
              Çıxış et
            </button>
            <div className="bg-slate-950 rounded-lg p-3 text-xs text-slate-500">
              <p className="font-medium text-slate-400 truncate mb-1">Hesab: {currentUser?.username || 'Bilinmir'}</p>
              <p>Version 2.1.0</p>
            </div>
          </div>
        </div>
      </aside>

      {/* Main Content */}
      <main className="flex-1 overflow-auto min-h-0 pb-[calc(92px+env(safe-area-inset-bottom))] md:pb-0">
        {children}
      </main>
    </div>
  );
}
