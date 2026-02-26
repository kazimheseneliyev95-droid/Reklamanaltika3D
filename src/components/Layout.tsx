import { Link, useLocation } from 'react-router-dom';
import { LayoutDashboard, Calculator, ShieldCheck, LogOut } from 'lucide-react';
import { useAppStore } from '../context/Store';
import { cn } from '../lib/utils';

export default function Layout({ children }: { children: React.ReactNode }) {
  const location = useLocation();
  const { logout, currentUser } = useAppStore();

  const navItems = currentUser?.role === 'superadmin'
    ? [
      { name: 'Global İdarəetmə', path: '/superadmin', icon: <ShieldCheck className="w-5 h-5" /> }
    ]
    : [
      { name: 'Simulator', path: '/', icon: <Calculator className="w-5 h-5" /> },
      { name: 'CRM (Classic)', path: '/crm', icon: <LayoutDashboard className="w-5 h-5" /> },
    ];

  return (
    <div className="min-h-screen bg-slate-950 text-slate-50 flex flex-col md:flex-row">
      {/* Mobile Top Bar (Minimal) */}
      <div className="mobile-topbar md:hidden flex items-center justify-between p-3 bg-slate-900 border-b border-slate-800 sticky top-0 z-40">
        <div className="min-w-0">
          <h1 className="text-lg font-bold bg-gradient-to-r from-blue-400 to-purple-400 bg-clip-text text-transparent leading-tight">
            ReklamAnalitika
          </h1>
          {currentUser?.display_name && (
            <p className="text-[10px] text-slate-500 truncate max-w-[70vw]">{currentUser.display_name}</p>
          )}
        </div>
        {currentUser?.role !== 'superadmin' && (
          <button
            onClick={logout}
            className="p-2 text-rose-400 hover:text-rose-300"
            title="Çıxış"
          >
            <LogOut className="w-5 h-5" />
          </button>
        )}
      </div>

      {/* Mobile Bottom Navigation (PWA style) */}
      <nav className="mobile-bottom-nav md:hidden fixed bottom-0 w-full bg-slate-900 border-t border-slate-800 z-50 flex items-center justify-around pb-safe">
        {navItems.map((item) => {
          const isActive = location.pathname === item.path;
          return (
            <Link
              key={item.path}
              to={item.path}
              className={cn(
                "flex flex-col items-center justify-center w-full py-2 gap-1 transition-colors",
                isActive ? "text-blue-400" : "text-slate-500 hover:text-slate-300"
              )}
            >
              <div className={cn("p-1.5 rounded-full", isActive && "bg-blue-600/20")}>
                {item.icon}
              </div>
              <span className="text-[10px] font-medium">{item.name}</span>
            </Link>
          );
        })}
        {currentUser?.role === 'superadmin' && (
          <button
            onClick={logout}
            className="flex flex-col items-center justify-center w-full py-2 gap-1 transition-colors text-rose-500 hover:text-rose-400"
          >
            <div className="p-1.5 rounded-full">
              <LogOut className="w-5 h-5" />
            </div>
            <span className="text-[10px] font-medium">Çıxış</span>
          </button>
        )}
      </nav>

      {/* Desktop Sidebar */}
      <aside className="hidden md:flex md:w-64 bg-slate-900 border-r border-slate-800 flex-shrink-0 flex-col">
        <div className="p-6 border-b border-slate-800">
          <h1 className="text-xl font-bold bg-gradient-to-r from-blue-400 to-purple-400 bg-clip-text text-transparent">
            ReklamAnalitika
          </h1>
          <p className="text-xs text-slate-500 mt-1">{currentUser?.display_name || 'Ads & CRM Suite'}</p>
        </div>

        <nav className="p-4 space-y-2 flex-1">
          {navItems.map((item) => (
            <Link
              key={item.path}
              to={item.path}
              className={cn(
                "flex items-center gap-3 px-4 py-3 rounded-lg text-sm font-medium transition-colors",
                location.pathname === item.path
                  ? "bg-blue-600 text-white shadow-lg shadow-blue-900/20"
                  : "text-slate-400 hover:text-white hover:bg-slate-800"
              )}
            >
              {item.icon}
              {item.name}
            </Link>
          ))}
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
      <main className="flex-1 overflow-auto min-h-0 pb-16 md:pb-0">
        {children}
      </main>
    </div>
  );
}
