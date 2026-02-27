import { useNavigate } from 'react-router-dom';
import { CRMSettingsPanel } from '../components/CRMSettingsPanel';

export default function AnalyticsSettingsPage() {
  const navigate = useNavigate();

  return (
    <CRMSettingsPanel
      variant="page"
      onClose={() => navigate('/analytics')}
    />
  );
}
