import { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase } from '../../../supabase';

/**
 * F1: administrator-configured subjects and exam patterns. Loaded once when
 * the administrator workspace opens; the Subjects & Patterns tab reloads it.
 */
export function useSubjectCatalog() {
  const [subjectCatalog, setSubjectCatalog] = useState(/** @type {import('../../../types').SubjectCatalogEntry[]} */ ([]));
  const [examTemplates, setExamTemplates] = useState(/** @type {import('../../../types').ExamTemplateEntry[]} */ ([]));
  const [catalogState, setCatalogState] = useState({ loading: true, error: '' });

  const fetchSubjectCatalog = useCallback(async () => {
    setCatalogState(prev => ({ ...prev, loading: true }));
    try {
      const [subjectsResult, templatesResult] = await Promise.all([
        supabase.rpc('admin_list_subjects'),
        supabase.rpc('admin_list_exam_templates')
      ]);
      if (subjectsResult.error) throw subjectsResult.error;
      if (templatesResult.error) throw templatesResult.error;
      setSubjectCatalog(Array.isArray(subjectsResult.data) ? subjectsResult.data : []);
      setExamTemplates(Array.isArray(templatesResult.data) ? templatesResult.data : []);
      setCatalogState({ loading: false, error: '' });
    } catch (error) {
      console.error('Subjects and patterns could not be loaded:', error);
      setCatalogState({ loading: false, error: /** @type {Error} */ (error).message || 'Subjects and patterns could not be loaded.' });
    }
  }, []);

  useEffect(() => {
    fetchSubjectCatalog();
  }, [fetchSubjectCatalog]);

  const activeSubjectNames = useMemo(
    () => subjectCatalog.filter(subject => subject.isActive).map(subject => subject.name),
    [subjectCatalog]
  );
  const allSubjectNames = useMemo(() => subjectCatalog.map(subject => subject.name), [subjectCatalog]);
  const subjectOrder = useMemo(() => {
    /** @type {Map<string, number>} */
    const order = new Map();
    subjectCatalog.forEach((subject, index) => order.set(subject.name.toLowerCase(), index));
    return order;
  }, [subjectCatalog]);
  const compareSubjects = useCallback((/** @type {unknown} */ a, /** @type {unknown} */ b) => {
    const rankA = subjectOrder.has(String(a).toLowerCase()) ? /** @type {number} */ (subjectOrder.get(String(a).toLowerCase())) : Number.MAX_SAFE_INTEGER;
    const rankB = subjectOrder.has(String(b).toLowerCase()) ? /** @type {number} */ (subjectOrder.get(String(b).toLowerCase())) : Number.MAX_SAFE_INTEGER;
    return rankA - rankB || String(a).localeCompare(String(b));
  }, [subjectOrder]);
  const usableTemplates = useMemo(
    () => examTemplates.filter(template => template.isActive && !(/** @type {number} */ (template.inactiveSubjects?.length) > 0)),
    [examTemplates]
  );

  return {
    subjectCatalog,
    examTemplates,
    catalogState,
    fetchSubjectCatalog,
    activeSubjectNames,
    allSubjectNames,
    compareSubjects,
    usableTemplates
  };
}
