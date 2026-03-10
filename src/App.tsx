import { Suspense, lazy } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import Layout from './components/Layout';
import { AppProvider, useAppStore } from './context/Store';

const CRMPage = lazy(() => import('./pages/CRM'));
const AnalyticsPage = lazy(() => import('./pages/Analytics'));
const ResponseTimesPage = lazy(() => import('./pages/ResponseTimes'));
const SettingsPage = lazy(() => import('./pages/Settings'));
const FacebookImportPage = lazy(() => import('./pages/FacebookImport'));
const Login = lazy(() => import('./pages/Login'));
const SuperAdminDashboard = lazy(() => import('./pages/SuperAdminDashboard'));

function PageLoader() {
  return (
    <div className="min-h-screen bg-slate-950 flex items-center justify-center">
      <div className="flex items-center gap-3 rounded-xl border border-slate-800 bg-slate-900/80 px-4 py-3 text-sm text-slate-300 shadow-lg shadow-slate-950/30">
        <div className="h-5 w-5 animate-spin rounded-full border-2 border-slate-700 border-t-blue-500" />
        <span>Yuklenir...</span>
      </div>
    </div>
  );
}

function AuthGuard({ children }: { children: React.ReactNode }) {
  const { isAuthenticated, isLoadingAuth } = useAppStore();

  if (isLoadingAuth) {
    return (
      <div className="min-h-screen bg-[#0d1117] flex items-center justify-center">
        <div className="w-8 h-8 border-4 border-slate-800 border-t-blue-500 rounded-full animate-spin"></div>
      </div>
    );
  }

  if (!isAuthenticated) {
    return (
      <Suspense fallback={<PageLoader />}>
        <Login />
      </Suspense>
    );
  }

  return <>{children}</>;
}

// Sub-component to enforce role-based routing
function RoleBasedRouter() {
  const { currentUser } = useAppStore();
  const canViewStats = currentUser?.permissions?.view_stats !== false;

  if (currentUser?.role === 'superadmin') {
    return (
      <Suspense fallback={<PageLoader />}>
        <Routes>
          <Route path="/superadmin" element={<SuperAdminDashboard />} />
          <Route path="*" element={<Navigate to="/superadmin" replace />} />
        </Routes>
      </Suspense>
    );
  }

  return (
    <Suspense fallback={<PageLoader />}>
      <Routes>
        <Route path="/" element={<Navigate to="/crm" replace />} />
        <Route path="/crm" element={<CRMPage />} />
        <Route path="/analytics" element={canViewStats ? <AnalyticsPage /> : <Navigate to="/crm" replace />} />
        <Route path="/facebook-import" element={<FacebookImportPage />} />
        <Route path="/analytics/response-times" element={canViewStats ? <ResponseTimesPage /> : <Navigate to="/crm" replace />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="/analytics/settings" element={<Navigate to="/settings" replace />} />
        <Route path="/whatsapp" element={<Navigate to="/crm" replace />} />
        <Route path="*" element={<Navigate to="/crm" replace />} />
      </Routes>
    </Suspense>
  );
}

function App() {
  return (
    <AppProvider>
      <AuthGuard>
        <BrowserRouter>
          <Layout>
            <RoleBasedRouter />
          </Layout>
        </BrowserRouter>
      </AuthGuard>
    </AppProvider>
  );
}

export default App;
