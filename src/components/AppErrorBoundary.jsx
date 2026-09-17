import React from 'react';
import { createIncidentId, reportClientError } from '../runtimeDiagnostics';

const RecoveryScreen = ({ incidentId, startup = false }) => (
  <main role="alert" style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: '24px', background: 'var(--bg-color, #f8fafc)' }}>
    <section style={{ width: '100%', maxWidth: '560px', padding: '32px', borderRadius: '12px', background: 'white', border: '1px solid #cbd5e1', boxShadow: '0 10px 25px rgba(15,23,42,0.08)' }}>
      <h1 style={{ marginTop: 0, color: '#0f172a' }}>{startup ? 'Application configuration problem' : 'The examination portal encountered a problem'}</h1>
      <p style={{ color: '#475569', lineHeight: 1.6 }}>
        {startup
          ? 'The portal could not start. Ask the system administrator to verify its public service configuration.'
          : 'Your saved exam progress has not been cleared. Reload the portal to recover from the server-confirmed attempt.'}
      </p>
      <p style={{ color: '#475569' }}>Reference: <code>{incidentId}</code></p>
      <button type="button" onClick={() => window.location.reload()} style={{ padding: '11px 18px', border: 0, borderRadius: '6px', color: 'white', background: '#2563eb', cursor: 'pointer', fontWeight: 700 }}>
        Reload portal
      </button>
    </section>
  </main>
);

export const StartupFailure = ({ error }) => {
  const incidentId = React.useMemo(() => reportClientError(error, 'application.startup') || createIncidentId(), [error]);
  return <RecoveryScreen incidentId={incidentId} startup />;
};

class AppErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null, incidentId: null };
  }

  static getDerivedStateFromError(error) {
    return { error, incidentId: createIncidentId() };
  }

  componentDidCatch(error) {
    const reportedId = reportClientError(error, 'react.render');
    if (reportedId) this.setState({ incidentId: reportedId });
  }

  render() {
    if (this.state.error) return <RecoveryScreen incidentId={this.state.incidentId} />;
    return this.props.children;
  }
}

export default AppErrorBoundary;
