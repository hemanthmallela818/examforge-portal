import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase } from '../../../supabase';

/**
 * Aggregate row counts and database size shown on the overview and the database cleaner.
 * @param {import('../../../types').RunAdminDataLoad} runAdminDataLoad
 */
export function useTableCounts(runAdminDataLoad) {
  const [dbSize, setDbSize] = useState(/** @type {number | null} */ (null));
  const [tableCounts, setTableCounts] = useState(/** @type {import('../../../types').TableCounts} */ ({
    question_bank: null,
    cbt_exams: null,
    student_results: null,
    active_sessions: null,
    students: null,
    classes: null,
    import_history: null
  }));
  const countRefreshTimer = useRef(/** @type {ReturnType<typeof setTimeout> | null} */ (null));

  const fetchTableCounts = useCallback(async () => {
    const result = await runAdminDataLoad('counts', 'Dashboard totals could not be refreshed. Existing figures may be stale.', async () => {
      const [q, e, r, s, st, c, h, size] = await Promise.all([
        supabase.from('question_bank').select('id', { count: 'exact', head: true }),
        supabase.from('cbt_exams').select('id', { count: 'exact', head: true }),
        supabase.from('student_results').select('id', { count: 'exact', head: true }),
        supabase.from('active_sessions').select('id', { count: 'exact', head: true }),
        supabase.from('students').select('id', { count: 'exact', head: true }),
        supabase.from('classes').select('id', { count: 'exact', head: true }),
        supabase.from('import_history').select('id', { count: 'exact', head: true }),
        supabase.rpc('get_db_size')
      ]);
      const failed = [q, e, r, s, st, c, h, size].find(result => result.error);
      if (failed?.error) throw failed.error;
      const sizeData = size.data;
      return {
        counts: {
          question_bank: q.count || 0,
          cbt_exams: e.count || 0,
          student_results: r.count || 0,
          active_sessions: s.count || 0,
          students: st.count || 0,
          classes: c.count || 0,
          import_history: h.count || 0
        },
        totalSize: sizeData
          ? sizeData.reduce((/** @type {number} */ sum, /** @type {{ size_bytes?: unknown }} */ row) => sum + Number(row.size_bytes || 0), 0)
          : null
      };
    });
    if (result.ok && result.current) {
      setTableCounts(result.data.counts);
      if (result.data.totalSize !== null) setDbSize(result.data.totalSize);
    }
    return result.ok;
  }, [runAdminDataLoad]);

  const scheduleTableCounts = useCallback(() => {
    if (countRefreshTimer.current) clearTimeout(countRefreshTimer.current);
    countRefreshTimer.current = setTimeout(() => {
      countRefreshTimer.current = null;
      fetchTableCounts();
    }, 300);
  }, [fetchTableCounts]);

  useEffect(() => {
    const timerRef = countRefreshTimer;
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  return { tableCounts, dbSize, fetchTableCounts, scheduleTableCounts };
}
