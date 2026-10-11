// Accrue locally, piggyback cumulative timing on answers, and send a changed-only
// fallback after 60 seconds without a successful timing save.
import { useCallback, useEffect, useRef } from 'react';
import { supabase } from '../../supabase';

/**
 * @param {{
 *   examState: string,
 *   activeSubject: string,
 *   activeExamId: string | undefined,
 *   currentStudent: object | null,
 *   lockdownActiveRef: { current: boolean },
 *   initialSubjectTimeSeconds?: Record<string, number>,
 *   accessGenerationRef?: { current: number | null },
 *   answerSavingRef: { current: boolean }
 * }} options
 */
export function useSubjectTime({ examState, activeSubject, activeExamId, currentStudent, lockdownActiveRef, initialSubjectTimeSeconds, accessGenerationRef, answerSavingRef }) {
  const subjectTimeRef = useRef(initialSubjectTimeSeconds || {});
  const subjectTickRef = useRef(performance.now());
  const lastSentSubjectTimeRef = useRef(JSON.stringify(initialSubjectTimeSeconds || {}));
  const lastTimingSaveRef = useRef(performance.now());
  const timingInFlightRef = useRef(false);

  const accrueActiveSubjectTime = useCallback(() => {
    const now = performance.now();
    const elapsedSeconds = Math.max(0, Math.floor((now - subjectTickRef.current) / 1000));
    if (elapsedSeconds === 0) return;
    subjectTickRef.current += elapsedSeconds * 1000;
    if (examState !== 'ACTIVE' || !activeSubject || lockdownActiveRef.current
      || document.visibilityState !== 'visible' || !document.hasFocus()) return;
    subjectTimeRef.current = {
      ...subjectTimeRef.current,
      [activeSubject]: Number(subjectTimeRef.current[activeSubject] || 0) + elapsedSeconds
    };
  }, [activeSubject, examState, lockdownActiveRef]);

  const getSubjectTimeSnapshot = useCallback(() => {
    accrueActiveSubjectTime();
    return { ...subjectTimeRef.current };
  }, [accrueActiveSubjectTime]);

  const markSubjectTimeSaved = useCallback((/** @type {Record<string, number>} */ snapshot) => {
    lastSentSubjectTimeRef.current = JSON.stringify(snapshot);
    lastTimingSaveRef.current = performance.now();
  }, []);

  const syncSubjectTime = useCallback(async ({ onlyIfChanged = false } = {}) => {
    const timing = getSubjectTimeSnapshot();
    if (!activeExamId || !currentStudent || lockdownActiveRef.current || navigator.onLine === false || timingInFlightRef.current) return;
    const snapshot = JSON.stringify(timing);
    if (onlyIfChanged && snapshot === lastSentSubjectTimeRef.current) return;
    timingInFlightRef.current = true;
    try {
      const { error } = await supabase.rpc('sync_exam_subject_time', {
        exam_id_param: activeExamId,
        subject_time_seconds_param: timing,
        access_generation_param: accessGenerationRef?.current ?? null
      });
      if (error) throw error;
      markSubjectTimeSaved(timing);
    } finally {
      timingInFlightRef.current = false;
    }
  }, [getSubjectTimeSnapshot, activeExamId, currentStudent, accessGenerationRef, lockdownActiveRef, markSubjectTimeSaved]);

  const syncRef = useRef(syncSubjectTime);
  useEffect(() => { syncRef.current = syncSubjectTime; });

  useEffect(() => {
    if (examState !== 'ACTIVE') return;
    subjectTickRef.current = performance.now();
    const interval = setInterval(accrueActiveSubjectTime, 1000);
    return () => { clearInterval(interval); accrueActiveSubjectTime(); };
  }, [accrueActiveSubjectTime, examState]);

  useEffect(() => {
    if (examState !== 'ACTIVE') return;
    let disposed = false;
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let timer;
    const fallback = async () => {
      let nextDelay = 60_000;
      try {
        const sinceSave = performance.now() - lastTimingSaveRef.current;
        if (sinceSave < 60_000) {
          nextDelay = 60_000 - sinceSave;
        } else if (answerSavingRef.current) {
          nextDelay = 1000;
        } else {
          await syncRef.current({ onlyIfChanged: true });
        }
      } catch (error) {
        console.warn('Subject timing sync failed:', error);
      } finally {
        if (!disposed) timer = setTimeout(fallback, nextDelay);
      }
    };
    timer = setTimeout(fallback, 60_000);
    return () => { disposed = true; clearTimeout(timer); };
  }, [examState, activeExamId, answerSavingRef]);

  return { subjectTimeRef, subjectTickRef, syncSubjectTime, getSubjectTimeSnapshot, markSubjectTimeSaved, timingInFlightRef };
}
