import { AlertTriangle, LogOut, PencilLine, ShieldCheck, WifiOff } from 'lucide-react';
import { Alert, Button, cn } from './ui';
import { useState, useEffect, useRef } from 'react';
import { useDialogFocusTrap } from '../dialogFocus';

/**
 * @param {{
 *   offlineSince: number,
 *   onLogout: () => void,
 *   onContinueOffline: () => void,
 *   recoveryAvailable?: boolean,
 *   onTerminate?: () => unknown
 * }} props `onTerminate` is accepted from ActiveExamView but not currently used.
 */
const OfflineOverlay = ({ offlineSince, onLogout, onContinueOffline, recoveryAvailable = true }) => {
  const [elapsed, setElapsed] = useState(0);
  const continueButtonRef = useRef(/** @type {HTMLButtonElement | null} */ (null));
  const { dialogRef, handleDialogKeyDown } = useDialogFocusTrap({ initialFocusRef: continueButtonRef });

  useEffect(() => {
    if (!offlineSince) return;

    const intervalId = setInterval(() => {
      const elapsedSeconds = Math.floor((Date.now() - offlineSince) / 1000);
      setElapsed(elapsedSeconds);
    }, 1000);

    return () => clearInterval(intervalId);
  }, [offlineSince]);

  /** @param {number} seconds */
  const formatElapsed = (seconds) => {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m}:${s.toString().padStart(2, '0')}`;
  };

  return (
    <div
      ref={/** @type {import('react').RefObject<HTMLDivElement | null>} */ (dialogRef)}
      role="dialog"
      aria-modal="true"
      aria-labelledby="offline-overlay-title"
      tabIndex={-1}
      onKeyDown={handleDialogKeyDown}
      className="fixed inset-0 z-[9999] flex items-center justify-center overflow-y-auto bg-slate-950/80 p-4 backdrop-blur-sm"
    >
      <div className="animate-fade-in my-auto w-full max-w-lg rounded-2xl border border-slate-200 bg-white p-6 text-center shadow-2xl sm:p-8">
        <div className="mx-auto mb-4 grid size-14 place-items-center rounded-full bg-red-50 text-red-600 ring-8 ring-red-50/60">
          <WifiOff className="size-7" aria-hidden="true" />
        </div>
        <h1 id="offline-overlay-title" className="mb-2 text-xl font-semibold tracking-tight text-slate-900 sm:text-2xl">
          Internet Connection Dropped
        </h1>
        <p className="mb-5 text-sm leading-relaxed text-slate-600">
          Your device has lost network connectivity. The official examination timer continues to run.
          <strong className={cn('mt-2 flex items-center justify-center gap-1.5 font-semibold', recoveryAvailable ? 'text-emerald-700' : 'text-red-700')}>
            {recoveryAvailable
              ? <ShieldCheck className="size-4 shrink-0" aria-hidden="true" />
              : <AlertTriangle className="size-4 shrink-0" aria-hidden="true" />}
            {recoveryAvailable
              ? 'A local recovery copy is active for answers selected on this device.'
              : 'Local recovery storage is unavailable. Keep this page open and reconnect immediately.'}
          </strong>
        </p>

        <div className="mx-auto mb-6 w-fit rounded-xl border border-red-200 bg-red-50 px-8 py-3">
          <div className="text-xs font-semibold uppercase tracking-wider text-red-700">
            Time Offline
          </div>
          <div className="font-mono text-4xl font-bold text-red-900 tabular-nums">
            {formatElapsed(elapsed)}
          </div>
        </div>

        <div className="flex flex-col justify-center gap-3 sm:flex-row">
          {onContinueOffline && (
            <Button
              ref={continueButtonRef}
              variant="success"
              size="lg"
              onClick={onContinueOffline}
            >
              <PencilLine aria-hidden="true" /> Continue Answering Offline
            </Button>
          )}
          <Button
            variant="secondary"
            size="lg"
            onClick={onLogout}
          >
            <LogOut aria-hidden="true" /> Logout & Resume Later
          </Button>
        </div>
        <Alert variant="warning" className="mt-6 text-left text-xs">
          <strong className="font-semibold">Important Examination Policy:</strong> The timer continues while offline. After the timer reaches zero, the server grades only answers it confirmed before the deadline. The three-minute recovery window is for delivering the submission request; it never provides extra answering time.
        </Alert>
      </div>
    </div>
  );
};

export default OfflineOverlay;
