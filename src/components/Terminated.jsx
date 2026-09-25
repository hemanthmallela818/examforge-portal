import { ArrowLeft, ShieldAlert } from 'lucide-react';
import { Button } from './ui';

/** @param {{ onBackToDashboard?: () => void }} props */
const Terminated = ({ onBackToDashboard }) => {
  return (
    <div className="terminated-overlay theme-island animate-fade-in bg-slate-950/95 px-4 backdrop-blur-sm" role="alert" aria-labelledby="terminated-title">
      <div className="terminated-card w-full max-w-lg rounded-2xl border border-red-200 bg-white p-8 text-center text-slate-900 shadow-2xl">
        <div className="mx-auto mb-5 grid size-16 place-items-center rounded-full bg-red-50 text-red-600 ring-8 ring-red-50/60">
          <ShieldAlert className="size-8" aria-hidden="true" />
        </div>
        <h1 id="terminated-title" className="mb-3 text-2xl font-semibold tracking-tight text-red-700 sm:text-3xl">Exam Terminated</h1>
        <p className="mb-4 text-base leading-relaxed text-slate-600">
          Violation Detected: You navigated away from the exam window or exited fullscreen mode.
        </p>
        <p className="mb-6 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-semibold text-red-800">
          Your attempt will be finalized using the answers confirmed by the server before termination.
        </p>
        {onBackToDashboard && (
          <Button size="lg" onClick={onBackToDashboard} className="w-full sm:w-auto">
            <ArrowLeft aria-hidden="true" /> Return to Dashboard
          </Button>
        )}
      </div>
    </div>
  );
};

export default Terminated;
