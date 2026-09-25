/// <reference path="../features/exam/browserApis.d.ts" />
import { memo, useEffect, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, CloudOff, Loader2, Lock, RefreshCw, Signal, SignalLow, SignalMedium, Timer, UserRound, WifiOff } from 'lucide-react';
import { cn } from './ui';
import { announceAssertive, announcePolite } from './LiveAnnouncer';
import { checkTimerMilestones } from '../accessibilityLogic';
import { useRemainingSeconds } from '../features/exam/examClock';
import { EXAM_TEXT_SIZES } from '../features/exam/useExamTextSize';
import BrandLogo from '../branding/BrandLogo';
import { useBranding } from '../branding/brandingStore';
import ThemeToggle from '../theme/ThemeToggle';

/** @param {number} seconds */
const formatTime = (seconds) => {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
};

// The countdown text is the only part of the exam screen that changes every
// second, so it owns its own subscription and milestone announcements.
/** @param {{ timeLeft: number, paused?: boolean }} props */
const ExamTimerDisplay = ({ timeLeft, paused }) => {
  const announcedMilestonesRef = useRef(/** @type {Set<number>} */ (new Set()));
  const previousTimeRef = useRef(timeLeft);

  // Screen-reader timer milestone announcements
  useEffect(() => {
    if (typeof timeLeft !== 'number' || paused) return;

    const triggered = checkTimerMilestones(timeLeft, announcedMilestonesRef.current, previousTimeRef.current);
    previousTimeRef.current = timeLeft;
    triggered.forEach(({ label }) => {
      announceAssertive(label);
    });
  }, [timeLeft, paused]);

  const isUrgent = !paused && timeLeft <= 300;

  return (
    <span
      role="timer"
      aria-label={`${formatTime(timeLeft)} remaining`}
      className={cn(
        'rounded-full bg-slate-950/30 px-3 py-1 font-mono text-base font-bold tabular-nums',
        isUrgent ? 'exam-timer--urgent' : undefined
      )}
    >
      {formatTime(timeLeft)}
    </span>
  );
};

// Derives the remaining time from the fixed server deadline on the shared
// one-second exam clock (see features/exam/examClock).
/** @param {{ endTime: number | null, paused?: boolean }} props */
const ExamCountdown = ({ endTime, paused }) => {
  // Null only when there is no deadline yet; formatTime renders it as 00:00:00.
  const timeLeft = /** @type {number} */ (useRemainingSeconds(endTime));
  return <ExamTimerDisplay timeLeft={timeLeft} paused={paused} />;
};

/** @param {{ autosaveStatus: string }} props */
const AutosaveIndicator = ({ autosaveStatus }) => {
  const latestStatusRef = useRef(autosaveStatus);
  const [saveClock, setSaveClock] = useState(() => {
    const now = Date.now();
    return { now, savedAt: now, status: autosaveStatus };
  });

  useEffect(() => {
    latestStatusRef.current = autosaveStatus;
  }, [autosaveStatus]);

  // Refresh the "saved N seconds ago" label once per second.
  useEffect(() => {
    const tick = () => setSaveClock(prev => {
      const now = Date.now();
      const status = latestStatusRef.current;
      const savedAt = status === 'SAVED' && prev.status !== 'SAVED' ? now : prev.savedAt;
      return { now, savedAt, status };
    });
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);

  const formatSavedAgo = () => {
    const seconds = Math.max(0, Math.round((saveClock.now - saveClock.savedAt) / 1000));
    if (seconds < 5) return 'just now';
    if (seconds < 60) return `${seconds}s ago`;
    const minutes = Math.floor(seconds / 60);
    return `${minutes} min ago`;
  };

  /**
   * @param {import('react').ElementType} Icon
   * @param {string} [extra]
   */
  const icon = (Icon, extra = '') => <Icon className={cn('size-4 shrink-0', extra)} aria-hidden="true" />;
  const pill = 'inline-flex items-center gap-1.5';
  switch (autosaveStatus) {
    case 'SAVING':
      return <span className={cn(pill, 'text-amber-200')} title="Saving responses to server...">{icon(Loader2, 'animate-spin')} Saving…</span>;
    case 'OFFLINE':
      return <span className={cn(pill, 'text-orange-200')} title="Offline: Responses saved to local storage">{icon(CloudOff)} Saved on this device</span>;
    case 'RETRYING':
      return <span className={cn(pill, 'text-amber-200')} title="Retrying synchronization...">{icon(RefreshCw, 'animate-spin')} Syncing…</span>;
    case 'FAILED':
      return <span className={cn(pill, 'text-red-200')} title="Autosave failed. Check connection.">{icon(AlertTriangle)} Save Failed</span>;
    case 'CONFLICT':
      return <span className={cn(pill, 'text-orange-200')} title="Newer server-confirmed progress was kept.">{icon(AlertTriangle)} Server Copy Kept</span>;
    case 'LOCKED':
      return <span className={cn(pill, 'text-slate-200')} title="The exam deadline has passed.">{icon(Lock)} Answers Locked</span>;
    case 'SAVED':
    default:
      return (
        <span className={cn(pill, 'text-emerald-200')} title="All responses saved to server">
          {icon(CheckCircle2)} Saved <span className="exam-status-pill__detail">· {formatSavedAgo()}</span>
        </span>
      );
  }
};

// Question text size control (U11). Plain buttons with aria-pressed: pointer
// and Enter/Space activation only, so it never needs a Ctrl/Alt shortcut that
// the exam lockdown would count as a violation.
/**
 * @param {{
 *   value: import('../features/exam/useExamTextSize').ExamTextSize,
 *   onChange: (value: import('../features/exam/useExamTextSize').ExamTextSize) => void
 * }} props
 */
const TextSizeControl = ({ value, onChange }) => (
  <div
    role="group"
    aria-label="Question text size"
    className="exam-text-size-control flex items-center gap-1 rounded-full bg-white/10 p-1 ring-1 ring-white/15"
  >
    <span className="sr-only">Text size</span>
    {EXAM_TEXT_SIZES.map((size) => {
      const pressed = size.value === value;
      return (
        <button
          key={size.value}
          type="button"
          aria-pressed={pressed}
          aria-label={size.name}
          title={size.name}
          onClick={() => onChange(size.value)}
          className={cn(
            'grid h-9 min-w-9 place-items-center rounded-full px-2 font-semibold leading-none transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white max-[900px]:h-11 max-[900px]:min-w-11',
            size.value === 'small' ? 'text-xs' : size.value === 'large' ? 'text-base' : 'text-sm',
            pressed ? 'bg-white text-brand-700 shadow-sm' : 'text-brand-50 hover:bg-white/15'
          )}
        >
          <span aria-hidden="true">{size.label}</span>
        </button>
      );
    })}
  </div>
);

/**
 * @param {{
 *   subjects: string[],
 *   activeSubject: string,
 *   setActiveSubject: (subject: string) => void,
 *   studentName?: string,
 *   examTitle?: string,
 *   paused?: boolean,
 *   endTime?: number | null,
 *   timeLeft?: number,
 *   autosaveStatus?: string,
 *   textSize?: import('../features/exam/useExamTextSize').ExamTextSize,
 *   onTextSizeChange?: (value: import('../features/exam/useExamTextSize').ExamTextSize) => void
 * }} props
 */
const ExamNavbar = ({
  subjects,
  activeSubject,
  setActiveSubject,
  studentName,
  examTitle,
  paused = false,
  // Either a fixed deadline (epoch ms; the navbar ticks on its own) or a
  // precomputed number of seconds.
  endTime,
  timeLeft,
  autosaveStatus = 'SAVED',
  textSize = 'default',
  onTextSizeChange
}) => {
  const [networkStatus, setNetworkStatus] = useState({
    online: typeof navigator !== 'undefined' ? navigator.onLine : true,
    effectiveType: typeof navigator !== 'undefined' ? navigator.connection?.effectiveType || 'unknown' : 'unknown',
    downlink: typeof navigator !== 'undefined' ? navigator.connection?.downlink || 0 : 0
  });

  const { institutionName } = useBranding();
  const prevAutosaveRef = useRef(autosaveStatus);

  // Screen-reader autosave status announcements
  useEffect(() => {
    if (prevAutosaveRef.current !== autosaveStatus) {
      if (autosaveStatus === 'SAVED') {
        announcePolite('Response saved to server.');
      } else if (autosaveStatus === 'OFFLINE') {
        announcePolite('Response saved locally offline.');
      } else if (autosaveStatus === 'FAILED') {
        announceAssertive('Autosave failed. Check your network connection.');
      }
      prevAutosaveRef.current = autosaveStatus;
    }
  }, [autosaveStatus]);

  useEffect(() => {
    const handleOnline = () => {
      setNetworkStatus(prev => ({ ...prev, online: true }));
      announcePolite('Internet connection restored. You are online.');
    };
    const handleOffline = () => {
      setNetworkStatus(prev => ({ ...prev, online: false }));
      announceAssertive('Warning: Internet connection lost. You are offline. Responses will be saved locally.');
    };
    const handleConnectionChange = () => {
      setNetworkStatus(prev => ({
        ...prev,
        effectiveType: navigator.connection?.effectiveType || 'unknown',
        downlink: navigator.connection?.downlink || 0
      }));
    };

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    if (typeof navigator !== 'undefined' && navigator.connection) {
      navigator.connection.addEventListener('change', handleConnectionChange);
    }

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
      if (typeof navigator !== 'undefined' && navigator.connection) {
        navigator.connection.removeEventListener('change', handleConnectionChange);
      }
    };
  }, []);

  const getNetworkIndicator = () => {
    if (!networkStatus.online) {
      return (
        <span title="Offline" className="inline-flex items-center gap-1.5 text-red-200">
          <WifiOff className="size-4 shrink-0" aria-hidden="true" /> Offline
        </span>
      );
    }
    // Network is online
    let tone = 'text-emerald-200'; // Green (Good)
    let text = 'Good';
    let Icon = Signal;
    if (networkStatus.effectiveType === '3g' || (networkStatus.downlink > 0 && networkStatus.downlink < 3)) {
      tone = 'text-amber-200'; // Yellow (Fair)
      text = 'Fair';
      Icon = SignalMedium;
    } else if (networkStatus.effectiveType === '2g' || networkStatus.effectiveType === 'slow-2g') {
      tone = 'text-orange-200'; // Orange (Weak)
      text = 'Weak';
      Icon = SignalLow;
    }

    return (
      <span title={`${networkStatus.effectiveType.toUpperCase()} - ~${networkStatus.downlink}Mbps`} className={cn('inline-flex items-center gap-1.5', tone)}>
        <Icon className="size-4 shrink-0" aria-hidden="true" /> Connection: {text}
      </span>
    );
  };

  return (
    <div className="exam-navbar theme-island flex flex-col bg-brand-700 text-white shadow-md">
      {/* Top Header */}
      <div className="exam-navbar-header flex items-center justify-between gap-4 px-5 py-3 [&>.exam-navbar-indicators]:flex [&>.exam-navbar-indicators]:flex-wrap [&>.exam-navbar-indicators]:items-center [&>.exam-navbar-indicators]:justify-end [&>.exam-navbar-indicators]:gap-2.5">
        <div className="flex min-w-0 items-center gap-3">
          <BrandLogo
            className="hidden sm:grid"
            imageClassName="size-10 rounded-xl bg-white p-1"
            tileClassName="size-10 rounded-xl bg-white/15 ring-1 ring-white/20"
            iconClassName="size-5"
          />
          <div className="min-w-0">
            {institutionName && <p className="exam-institution-name truncate text-xs font-medium text-brand-100">{institutionName}</p>}
            <h2 className="truncate text-lg font-semibold tracking-tight">{examTitle || 'JEE Main CBT Mock Test'}</h2>
            {studentName && (
              <div className="flex items-center gap-1.5 text-sm text-brand-100">
                <UserRound className="size-3.5 shrink-0" aria-hidden="true" />
                <span>Candidate: <span className="font-semibold text-white">{studentName}</span></span>
              </div>
            )}
          </div>
        </div>
        <div className="exam-navbar-indicators">
          <div role="status" aria-live="polite" aria-atomic="true" className="exam-status-pill">
            <AutosaveIndicator autosaveStatus={autosaveStatus} />
          </div>
          <div role="status" aria-live="polite" aria-atomic="true" className="exam-status-pill">
            {getNetworkIndicator()}
          </div>
          <div className="flex items-center gap-2 rounded-full bg-white/10 py-1 pl-3 pr-1 ring-1 ring-white/15">
            <span className="inline-flex items-center gap-1.5 text-sm font-medium text-brand-50">
              <Timer className="size-4 shrink-0" aria-hidden="true" />
              <span className="whitespace-nowrap max-[600px]:sr-only">{paused ? 'Timer Paused:' : 'Time Left:'}</span>
            </span>
            {endTime !== undefined
              ? <ExamCountdown endTime={endTime} paused={paused} />
              : <ExamTimerDisplay timeLeft={/** @type {number} */ (timeLeft)} paused={paused} />}
          </div>
          {onTextSizeChange && <TextSizeControl value={textSize} onChange={onTextSizeChange} />}
          {/* Buttons only (no arrow keys): arrows move between questions and
              the lockdown must never see a shortcut from this control. */}
          <ThemeToggle tone="inverse" arrowKeys={false} />
        </div>
      </div>

      {/* Subject Tabs */}
      <div className="exam-subject-tabs flex gap-1 bg-brand-800 px-5 pt-1.5" role="group" aria-label="Exam subjects">
        {subjects.map(sub => (
          <button
            key={sub}
            onClick={() => setActiveSubject(sub)}
            className={cn(
              'min-h-11 rounded-b-none rounded-t-lg border-b-[3px] px-5 py-2.5 text-sm font-semibold transition-colors',
              activeSubject === sub
                ? 'border-brand-500 bg-white text-brand-700'
                : 'border-transparent bg-transparent text-brand-100 hover:bg-white/10 hover:text-white'
            )}
          >
            {sub}
          </button>
        ))}
      </div>
    </div>
  );
};

// Memoized: with the countdown and "saved N ago" label ticking in their own
// subcomponents, the navbar re-renders only when its props change.
export default memo(ExamNavbar);
