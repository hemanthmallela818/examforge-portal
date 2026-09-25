import { useState, useEffect } from 'react';
import { supabase } from '../supabase';
import { checkBrowserCompatibility, isNarrowViewport } from '../runtimeConfig';
import { AlertTriangle, BookOpen, CheckCircle2, ClipboardList, Clock, Hourglass, ListChecks, Lock, MinusCircle, Play, ShieldCheck, Smartphone, XCircle } from 'lucide-react';
import { Alert, Badge, Button, Checkbox, cn } from './ui';

/**
 * @param {{
 *   startExam: () => void | Promise<void>,
 *   activeExamId?: string,
 *   duration?: number,
 *   marksCorrect?: number,
 *   marksIncorrect?: number,
 *   subjects?: string[]
 * }} props
 */
const PreExam = ({ startExam, activeExamId, duration = 180, marksCorrect = 4, marksIncorrect = -1, subjects = [] }) => {
  const [checked, setChecked] = useState(false);
  const [examStatus, setExamStatus] = useState('PENDING');
  const [statusError, setStatusError] = useState('');
  const [compatCheck] = useState(() => checkBrowserCompatibility());
  const [isMobileScreen, setIsMobileScreen] = useState(() => typeof window !== 'undefined' ? isNarrowViewport(window.innerWidth) : false);

  useEffect(() => {
    const updateViewport = () => setIsMobileScreen(isNarrowViewport(window.innerWidth));
    window.addEventListener('resize', updateViewport);
    return () => window.removeEventListener('resize', updateViewport);
  }, []);

  useEffect(() => {
    if (!activeExamId) return;

    const fetchInitialStatus = async () => {
      try {
        const { data, error } = await supabase
          .from('cbt_exams')
          .select('status')
          .eq('id', activeExamId)
          .single();
        
        if (error) throw error;
        if (data) {
          setExamStatus(data.status);
          setStatusError('');
        }
      } catch (err) {
        console.error("Failed to fetch exam status:", err);
        setStatusError('Unable to verify the exam status. Check your connection.');
      }
    };
    fetchInitialStatus();

    const channel = supabase
      .channel(`pre-exam-${activeExamId}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'exam_status_events', filter: `exam_id=eq.${activeExamId}` },
        (/** @type {{ new: { status?: string } }} */ payload) => {
          if (payload.new && payload.new.status) {
            setExamStatus(payload.new.status);
          }
        }
      )
      .subscribe();

    // Realtime delivers activation immediately; this jittered poll is only a fallback.
    const refreshInterval = setInterval(fetchInitialStatus, 20000 + Math.floor(Math.random() * 10000));

    return () => {
      clearInterval(refreshInterval);
      supabase.removeChannel(channel);
    };
  }, [activeExamId]);

  const isExamActive = examStatus === 'ACTIVE';

  const canStart = checked && isExamActive && compatCheck.compatible;
  const penalty = Math.abs(marksIncorrect);

  return (
    <div className="pre-exam-page flex min-h-dvh items-center justify-center bg-slate-50 px-4 py-8">
      <div className="animate-fade-in pre-exam-card w-full max-w-2xl rounded-2xl border border-slate-200 bg-white shadow-card max-[600px]:p-0!">
        <div className="flex items-start gap-4 border-b border-slate-100 px-4 py-5 sm:px-6">
          <div className="grid size-11 shrink-0 place-items-center rounded-xl bg-brand-50 text-brand-600 ring-1 ring-brand-100">
            <ClipboardList className="size-5" aria-hidden="true" />
          </div>
          <div className="min-w-0">
            <h1 className="text-2xl font-semibold tracking-tight text-slate-900">Exam Instructions</h1>
            <p className="mt-1 text-sm text-slate-500">Read everything below carefully before you begin.</p>
          </div>
        </div>

        <div className="flex flex-col gap-5 px-4 py-5 sm:px-6">
          {statusError && (
            <p role="alert" className="flex items-center gap-2 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-semibold text-red-800">
              <XCircle className="size-4 shrink-0" aria-hidden="true" />
              {statusError}
            </p>
          )}

          {/* Exam overview */}
          <div className="grid grid-cols-3 gap-2 sm:gap-3">
            <div className="flex min-w-0 flex-col items-start gap-1.5 rounded-xl border border-slate-200 bg-slate-50/60 px-3 py-3 sm:flex-row sm:items-center sm:gap-3 sm:px-4">
              <Clock className="size-5 shrink-0 text-brand-600" aria-hidden="true" />
              <div>
                <p className="text-xs font-medium text-slate-500">Duration</p>
                <p className="text-sm font-semibold text-slate-900 tabular-nums">{duration} minutes</p>
              </div>
            </div>
            <div className="flex min-w-0 flex-col items-start gap-1.5 rounded-xl border border-emerald-200 bg-emerald-50/60 px-3 py-3 sm:flex-row sm:items-center sm:gap-3 sm:px-4">
              <CheckCircle2 className="size-5 shrink-0 text-emerald-600" aria-hidden="true" />
              <div>
                <p className="text-xs font-medium text-slate-500">Correct answer</p>
                <p className="text-sm font-semibold text-emerald-700 tabular-nums">+{marksCorrect} marks</p>
              </div>
            </div>
            <div className="flex min-w-0 flex-col items-start gap-1.5 rounded-xl border border-red-200 bg-red-50/60 px-3 py-3 sm:flex-row sm:items-center sm:gap-3 sm:px-4">
              <MinusCircle className="size-5 shrink-0 text-red-600" aria-hidden="true" />
              <div>
                <p className="text-xs font-medium text-slate-500">Incorrect answer</p>
                <p className="text-sm font-semibold text-red-700 tabular-nums">-{penalty} mark{penalty === 1 ? '' : 's'}</p>
              </div>
            </div>
          </div>

          {subjects.length > 0 && (
            <div className="flex flex-wrap items-center gap-2">
              <span className="inline-flex items-center gap-1.5 text-sm font-medium text-slate-600">
                <BookOpen className="size-4 text-slate-400" aria-hidden="true" /> Sections:
              </span>
              {subjects.map(subject => <Badge key={subject} variant="brand">{subject}</Badge>)}
            </div>
          )}

          {/* Browser & Device Compatibility Check */}
          <div
            role={compatCheck.compatible ? 'status' : 'alert'}
            className={cn(
              'rounded-xl border px-4 py-3',
              compatCheck.compatible ? 'border-emerald-200 bg-emerald-50' : 'border-red-200 bg-red-50'
            )}
          >
            <div className={cn('flex items-center gap-2 text-sm font-semibold', compatCheck.compatible ? 'text-emerald-800' : 'text-red-800')}>
              {compatCheck.compatible
                ? <ShieldCheck className="size-5 shrink-0 text-emerald-600" aria-hidden="true" />
                : <AlertTriangle className="size-5 shrink-0 text-red-600" aria-hidden="true" />}
              <span>{compatCheck.compatible ? 'Browser & Device Verified: Offline recovery storage is working.' : 'This browser cannot safely start the exam.'}</span>
            </div>
            {!compatCheck.compatible && (
              <ul className="mt-2 flex flex-col gap-1 pl-7 text-xs text-red-700">
                {compatCheck.missingFeatures.map((f, i) => (
                  <li key={i} className="flex items-start gap-1.5">
                    <XCircle className="mt-px size-3.5 shrink-0" aria-hidden="true" />
                    <span>{f}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* Mobile Device Advisory */}
          {isMobileScreen && (
            <Alert variant="info" icon={Smartphone} title="Mobile Device Detected">
              You can take the exam on this device. For optimal readability of complex mathematical formulas and question navigation, we recommend a tablet, desktop, or landscape mode.
            </Alert>
          )}

          <section aria-labelledby="pre-exam-rules-title" className="rounded-xl border border-slate-200">
            <h2 id="pre-exam-rules-title" className="flex items-center gap-2 border-b border-slate-100 px-4 py-3 text-sm font-semibold text-slate-900">
              <ListChecks className="size-4 text-slate-500" aria-hidden="true" /> General instructions
            </h2>
            <ol className="flex flex-col gap-3 px-4 py-4 text-sm leading-relaxed text-slate-600">
              <li className="flex gap-3"><span className="grid size-6 shrink-0 place-items-center rounded-full bg-slate-100 text-xs font-semibold text-slate-700">1</span><p>The exam duration is {duration} minutes.</p></li>
              <li className="flex gap-3"><span className="grid size-6 shrink-0 place-items-center rounded-full bg-slate-100 text-xs font-semibold text-slate-700">2</span><p>The exam sections are: {subjects.join(', ') || 'as listed in your exam'}.</p></li>
              <li className="flex gap-3"><span className="grid size-6 shrink-0 place-items-center rounded-full bg-slate-100 text-xs font-semibold text-slate-700">3</span><p>Each correct answer awards +{marksCorrect} marks. Each incorrect answer deducts {Math.abs(marksIncorrect)} mark{Math.abs(marksIncorrect) === 1 ? '' : 's'}.</p></li>
              <li className="flex gap-3 rounded-lg bg-amber-50 p-3 text-amber-900 ring-1 ring-amber-200">
                <span className="grid size-6 shrink-0 place-items-center rounded-full bg-amber-100 text-xs font-semibold text-amber-800">4</span>
                <p><strong className="font-semibold">Security Warning:</strong> This exam requires fullscreen mode. Do not exit fullscreen, switch tabs, or use prohibited shortcuts. Repeated verified violations can terminate and finalize the attempt using your last server-confirmed answers.</p>
              </li>
            </ol>
          </section>
        </div>

        <div className="flex flex-col gap-4 rounded-b-2xl border-t border-slate-100 bg-slate-50/60 px-4 py-5 sm:px-6">
          <label htmlFor="agree" className="flex cursor-pointer items-center gap-3 rounded-lg border border-slate-200 bg-white px-4 py-3 text-sm font-medium text-slate-800 hover:border-brand-300">
            <Checkbox
              id="agree"
              checked={checked}
              onChange={(e) => setChecked(e.target.checked)}
              className="size-5"
            />
            <span>I have read and understood the instructions.</span>
          </label>

          <Button
            size="lg"
            variant={isExamActive ? 'primary' : 'secondary'}
            className="w-full"
            disabled={!checked || !isExamActive || !compatCheck.compatible}
            onClick={startExam}
          >
            {!compatCheck.compatible
              ? <><Lock aria-hidden="true" />Browser Storage Required to Start</>
              : isExamActive
                ? <><Play aria-hidden="true" />Start Exam</>
                : <><Hourglass aria-hidden="true" />Waiting for Admin to Start...</>}
          </Button>
          {!canStart && isExamActive && compatCheck.compatible && (
            <p className="text-center text-xs text-slate-500">Tick the checkbox above to enable the Start button.</p>
          )}
        </div>
      </div>
    </div>
  );
};

export default PreExam;
