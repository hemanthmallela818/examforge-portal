import React from 'react';
import { AlertOctagon, RotateCw, Settings2 } from 'lucide-react';
import { createIncidentId, reportClientError } from '../runtimeDiagnostics';
import { Button, Card, CardContent } from './ui';

/** @param {{ incidentId: string | null, startup?: boolean }} props */
const RecoveryScreen = ({ incidentId, startup = false }) => {
  const Icon = startup ? Settings2 : AlertOctagon;
  return (
    <main role="alert" className="grid min-h-screen place-items-center bg-slate-50 p-4 sm:p-6">
      <Card as="section" className="w-full max-w-lg text-center">
        <CardContent className="flex flex-col items-center px-6 py-10 sm:px-10">
          <div className="mb-5 grid size-14 place-items-center rounded-full bg-red-50 text-red-600 ring-1 ring-red-100">
            <Icon className="size-7" aria-hidden="true" />
          </div>
          <h1 className="text-xl font-semibold tracking-tight text-slate-900 sm:text-2xl">
            {startup ? 'Application configuration problem' : 'The examination portal encountered a problem'}
          </h1>
          <p className="mt-3 text-sm leading-relaxed text-slate-600">
            {startup
              ? 'The portal could not start. Ask the system administrator to verify its public service configuration.'
              : 'Your saved exam progress has not been cleared. Reload the portal to recover from the server-confirmed attempt.'}
          </p>
          <p className="mt-4 inline-flex flex-wrap items-center justify-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-1.5 text-xs text-slate-600">
            Reference: <code className="font-mono text-slate-900">{incidentId}</code>
          </p>
          <Button className="mt-6" size="lg" onClick={() => window.location.reload()}>
            <RotateCw aria-hidden="true" />
            Reload portal
          </Button>
        </CardContent>
      </Card>
    </main>
  );
};

/** @param {{ error: unknown }} props */
export const StartupFailure = ({ error }) => {
  const incidentId = React.useMemo(() => reportClientError(error, 'application.startup') || createIncidentId(), [error]);
  return <RecoveryScreen incidentId={incidentId} startup />;
};

/**
 * @typedef {{ children?: import('react').ReactNode }} AppErrorBoundaryProps
 * @typedef {{ error: unknown, incidentId: string | null }} AppErrorBoundaryState
 */

/** @extends {React.Component<AppErrorBoundaryProps, AppErrorBoundaryState>} */
class AppErrorBoundary extends React.Component {
  /** @param {AppErrorBoundaryProps} props */
  constructor(props) {
    super(props);
    this.state = { error: null, incidentId: null };
  }

  /**
   * @param {unknown} error
   * @returns {AppErrorBoundaryState}
   */
  static getDerivedStateFromError(error) {
    return { error, incidentId: createIncidentId() };
  }

  /** @param {unknown} error */
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
