import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import Layout from './components/Layout';
import FunnelSimulator from './components/FunnelSimulator';
import CRMPage from './pages/CRM';
import { AppProvider } from './context/Store';

function App() {
  return (
    <AppProvider>
      <BrowserRouter>
        <Layout>
          <Routes>
            <Route path="/" element={<FunnelSimulator />} />
            <Route path="/crm" element={<CRMPage />} />
            <Route path="/whatsapp" element={<Navigate to="/crm" replace />} />
          </Routes>
        </Layout>
      </BrowserRouter>
    </AppProvider>
  );
}

export default App;
