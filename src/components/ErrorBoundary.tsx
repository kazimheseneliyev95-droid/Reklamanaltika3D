import React from 'react';

type Props = {
  children: React.ReactNode;
};

type State = {
  hasError: boolean;
  message: string;
};

export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { hasError: false, message: '' };

  static getDerivedStateFromError(err: any): State {
    const msg = (err && (err.message || String(err))) ? String(err.message || err) : 'Unknown error';
    return { hasError: true, message: msg };
  }

  componentDidCatch(err: any) {
    try {
      console.error('UI crashed:', err);
    } catch {
      // ignore
    }
  }

  render() {
    if (!this.state.hasError) return this.props.children;

    return (
      <div style={{ minHeight: '100vh', background: '#0b1020', color: '#e5e7eb', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
        <div style={{ maxWidth: 520, width: '100%', border: '1px solid rgba(148, 163, 184, 0.25)', borderRadius: 16, background: 'rgba(2, 6, 23, 0.55)', padding: 18 }}>
          <div style={{ fontSize: 18, fontWeight: 800, marginBottom: 6 }}>Sistem xətası</div>
          <div style={{ fontSize: 12, opacity: 0.8, marginBottom: 12 }}>
            UI runtime xətası oldu. Yenilə etməklə adətən düzəlir.
          </div>
          <div style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace', fontSize: 12, color: '#cbd5e1', background: 'rgba(15, 23, 42, 0.6)', borderRadius: 12, padding: 12, border: '1px solid rgba(148, 163, 184, 0.18)' }}>
            {this.state.message}
          </div>
          <div style={{ display: 'flex', gap: 10, marginTop: 14 }}>
            <button
              onClick={() => window.location.reload()}
              style={{ flex: 1, padding: '10px 12px', borderRadius: 12, border: '1px solid rgba(59, 130, 246, 0.35)', background: 'rgba(37, 99, 235, 0.25)', color: '#fff', fontWeight: 800, cursor: 'pointer' }}
            >
              Yenilə
            </button>
            <button
              onClick={() => {
                try {
                  localStorage.removeItem('dualite_server_url');
                } catch { }
                window.location.reload();
              }}
              style={{ padding: '10px 12px', borderRadius: 12, border: '1px solid rgba(148, 163, 184, 0.25)', background: 'rgba(15, 23, 42, 0.5)', color: '#e5e7eb', fontWeight: 800, cursor: 'pointer' }}
            >
              Cache Sıfırla
            </button>
          </div>
        </div>
      </div>
    );
  }
}
