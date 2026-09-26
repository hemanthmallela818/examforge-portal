import { ArrowLeft, LogOut, ShieldAlert } from 'lucide-react';
import { Button } from './ui';

/** @param {import('../features/exam/examSessionHelpers').TerminationReason | null | undefined} reason */
const terminationReasonText = (reason) => {
  if (reason === 'tab') return 'You switched to another tab, window or app after the final warning.';
  if (reason === 'fullscreen') return 'You left fullscreen mode after the final warning.';
  return 'Your exam was ended before you submitted it.';
};

/**
 * @param {{
 *   reason?: import('../features/exam/examSessionHelpers').TerminationReason | null,
 *   onBackToDashboard?: () => void,
 *   onLogout?: () => void
 * }} props
 */
const Terminated = ({ reason, onBackToDashboard, onLogout }) => {
  return (
    <div className="terminated-overlay theme-island animate-fade-in bg-slate-950/95 px-4 backdrop-blur-sm" role="alert" aria-labelledby="terminated-title">
      <div className="terminated-card w-full max-w-lg rounded-2xl border border-red-200 bg-white p-8 text-center text-slate-900 shadow-2xl">
        <div className="mx-auto mb-5 grid size-16 place-items-center rounded-full bg-red-50 text-red-600 ring-8 ring-red-50/60">
          <ShieldAlert className="size-8" aria-hidden="true" />
        </div>
        <h1 id="terminated-title" className="mb-3 text-2xl font-semibold tracking-tight text-red-700 sm:text-3xl">Exam Terminated</h1>
        <p className="mb-4 text-base leading-relaxed text-slate-600">
          {terminationReasonText(reason)}
        </p>
        <p className="mb-6 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-semibold text-red-800">
          Your attempt will be finalized using the answers confirmed by the server before termination.
        </p>
        <div className="flex flex-col justify-center gap-3 sm:flex-row">
          {onBackToDashboard && (
            <Button size="lg" onClick={onBackToDashboard}>
              <ArrowLeft aria-hidden="true" /> Return to Dashboard
            </Button>
          )}
          {onLogout && (
            <Button size="lg" variant="secondary" onClick={onLogout}>
              <LogOut aria-hidden="true" /> Log out
            </Button>
          )}
        </div>
      </div>
    </div>
  );
};

export default Terminated;
