import { AppWindow, RotateCw } from 'lucide-react';
import { Button } from '../../components/ui';

/**
 * Shown instead of the exam when the same student already has it open in
 * another tab of this browser.
 * @param {{ status: 'blocked' | 'free', onContinueHere: () => void }} props
 */
export default function ExamTabLockedView({ status, onContinueHere }) {
  const free = status === 'free';
  return (
    <div className="grid min-h-dvh place-items-center bg-slate-50 px-4" role="alert" aria-labelledby="exam-tab-locked-title">
      <div className="w-full max-w-lg rounded-2xl border border-slate-200 bg-white p-8 text-center shadow-card">
        <div className="mx-auto mb-5 grid size-14 place-items-center rounded-full bg-amber-50 text-amber-600 ring-8 ring-amber-50/60">
          <AppWindow className="size-7" aria-hidden="true" />
        </div>
        <h1 id="exam-tab-locked-title" className="mb-3 text-2xl font-semibold tracking-tight text-slate-900">
          {free ? 'The other exam tab was closed' : 'This exam is already open in another tab'}
        </h1>
        <p className="mb-6 text-sm leading-relaxed text-slate-600">
          {free
            ? 'You can continue your exam in this tab. Your saved answers will be loaded.'
            : 'Your exam can only be open in one tab at a time. Go back to the tab where your exam is open, or close it and continue here. Your answers are safe.'}
        </p>
        <Button size="lg" disabled={!free} onClick={onContinueHere} className="w-full sm:w-auto">
          <RotateCw aria-hidden="true" /> Continue in this tab
        </Button>
      </div>
    </div>
  );
}
