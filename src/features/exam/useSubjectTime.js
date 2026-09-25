// Per-subject time accounting: accrues visible, focused, unlocked time to the
// active subject and syncs it to the server every 30 s when it has changed.
import { useCallback, useEffect, useRef } from 'react';
import { supabase } from '../../supabase';

/**
 * @param {{
 *   examState: string,
 *   activeSubject: string,
 *   activeExamId: string | undefined,
 *   currentStudent: object | null,
 *   lockdownActiveRef: { current: boolean },
 *   initialSubjectTimeSeconds?: Record<string, number>
 * }} options
 */
export function useSubjectTime({ examState, activeSubject, activeExamId, currentStudent, lockdownActiveRef, initialSubjectTimeSeconds }) {
  const subjectTimeRef = useRef(initialSubjectTimeSeconds || {});
  const subjectTickRef = useRef(Date.now());
  const lastSentSubjectTimeRef = useRef('');

  const accrueActiveSubjectTime = useCallback(() => {
    const now = Date.now();
    const elapsedSeconds = Math.max(0, Math.floor((now - subjectTickRef.current) / 1000));
    subjectTickRef.current = now;
    if (examState !== 'ACTIVE' || !activeSubject || lockdownActiveRef.current
      || document.visibilityState !== 'visible' || !document.hasFocus() || elapsedSeconds === 0) return;
    subjectTimeRef.current = {
      ...subjectTimeRef.current,
      [activeSubject]: Number(subjectTimeRef.current[activeSubject] || 0) + elapsedSeconds
    };
  }, [activeSubject, examState, lockdownActiveRef]);

  const syncSubjectTime = useCallback(async ({ onlyIfChanged = false } = {}) => {
    accrueActiveSubjectTime();
    if (!activeExamId || !currentStudent || navigator.onLine === false) return;
    const snapshot = JSON.stringify(subjectTimeRef.current);
    if (onlyIfChanged && snapshot === lastSentSubjectTimeRef.current) return;
    const { error } = await supabase.rpc('sync_exam_subject_time', {
      exam_id_param: activeExamId,
      subject_time_seconds_param: subjectTimeRef.current
    });
    if (error) throw error;
    lastSentSubjectTimeRef.current = snapshot;
  }, [accrueActiveSubjectTime, activeExamId, currentStudent]);

  useEffect(() => {
    if (examState !== 'ACTIVE') return;
    subjectTickRef.current = Date.now();
    const interval = setInterval(() => {
      syncSubjectTime({ onlyIfChanged: true }).catch(error => console.warn('Subject timing sync failed:', error));
    }, 30000);
    return () => {
      clearInterval(interval);
      accrueActiveSubjectTime();
    };
  }, [activeSubject, accrueActiveSubjectTime, examState, syncSubjectTime]);

  return { subjectTimeRef, subjectTickRef, syncSubjectTime };
}
