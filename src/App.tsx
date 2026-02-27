import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import Layout from './components/Layout';
import FunnelSimulator from './components/FunnelSimulator';
import CRMPage from './pages/CRM';
import AnalyticsPage from './pages/Analytics';
import SettingsPage from './pages/Settings';
import { AppProvider, useAppStore } from './context/Store';
import Login from './pages/Login';
import SuperAdminDashboard from './pages/SuperAdminDashboard';

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
    return <Login />;
  }

  return <>{children}</>;
}

// Sub-component to enforce role-based routing
function RoleBasedRouter() {
  const { currentUser } = useAppStore();

  if (currentUser?.role === 'superadmin') {
    return (
      <Routes>
        <Route path="/superadmin" element={<SuperAdminDashboard />} />
        <Route path="*" element={<Navigate to="/superadmin" replace />} />
      </Routes>
    );
  }

  return (
    <Routes>
      <Route path="/" element={<FunnelSimulator />} />
      <Route path="/crm" element={<CRMPage />} />
      <Route path="/analytics" element={<AnalyticsPage />} />
      <Route path="/settings" element={<SettingsPage />} />
      <Route path="/analytics/settings" element={<Navigate to="/settings" replace />} />
      <Route path="/whatsapp" element={<Navigate to="/crm" replace />} />
      <Route path="*" element={<Navigate to="/crm" replace />} />
    </Routes>
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
