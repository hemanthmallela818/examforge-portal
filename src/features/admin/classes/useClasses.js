import { useCallback, useEffect, useState } from 'react';
import { customAlert, customConfirm, customPrompt, showToast } from '../../../utils';
import { supabase } from '../../../supabase';
import { fetchAllRows } from '../../../paginatedQuery';
import { useAdminContext } from '../adminContext';

/**
 * Classes and sections. The list is shared (students, exam targeting), so the
 * hook is owned by AdminProvider; it takes the data-load services directly.
 * @param {{
 *   runAdminDataLoad: import('../../../types').RunAdminDataLoad,
 *   scheduleTableCounts: () => void,
 *   loadedCollections: import('react').RefObject<Set<string>>
 * }} services
 */
export function useClasses({ runAdminDataLoad, scheduleTableCounts, loadedCollections }) {
  const [classes, setClasses] = useState(/** @type {import('../../../types').ClassRow[]} */ ([]));
  const [newClassName, setNewClassName] = useState('');
  const [newClassSections, setNewClassSections] = useState('');

  const fetchClasses = useCallback(async () => {
    const result = await runAdminDataLoad('classes', 'Classes and sections could not be loaded. Existing entries may be stale.', () => fetchAllRows((from, to) => supabase.from('classes').select('*')
      .order('name', { ascending: true }).order('id', { ascending: true }).range(from, to)));
    if (!result.ok || !result.current) return result.ok;
    const data = result.data;
    setClasses(data || []);
    loadedCollections.current.add('classes');
    scheduleTableCounts();
    return true;
  }, [runAdminDataLoad, scheduleTableCounts, loadedCollections]);

  const handleCreateClass = async () => {
    if (!newClassName.trim() || !newClassSections.trim()) {
      await customAlert("Please enter a class name and sections first.");
      return;
    }
    const sectionsArray = newClassSections
      .split(',')
      .map(s => s.trim().toUpperCase())
      .filter(s => s.length > 0);

    if (sectionsArray.length === 0) {
      await customAlert("Please enter at least one valid section.");
      return;
    }

    try {
      const { error } = await supabase.from('classes').insert({
        name: newClassName.trim(),
        sections: sectionsArray
      });
      if (error) throw error;
      setNewClassName('');
      setNewClassSections('');
      await customAlert("Class created successfully!");
    } catch (err) {
      console.error(err);
      await customAlert("Failed to create class: " + /** @type {Error} */ (err).message);
    }
  };

  /** @param {string} classId */
  const handleDeleteClass = async (classId) => {
    const classRecord = classes.find(item => item.id === classId);
    if (!classRecord) return;
    const confirmation = await customPrompt(`Type the exact class name to delete it:\n\n${classRecord.name}`);
    if (confirmation === null) return;
    if (confirmation !== classRecord.name) {
      await customAlert('Class deletion cancelled because the name did not match exactly.');
      return;
    }
    if (!await customConfirm(`Permanently delete the empty class "${classRecord.name}"?`)) return;
    try {
      const { error } = await supabase.rpc('admin_delete_empty_class', {
        class_id_param: classId,
        expected_name_param: confirmation
      });
      if (error) throw error;
      showToast('Empty class deleted successfully.', 'success');
      await fetchClasses();
    } catch (err) {
      console.error(err);
      await customAlert(`Failed to delete class: ${/** @type {Error} */ (err).message}`);
    }
  };

  return {
    classes,
    fetchClasses,
    newClassName,
    setNewClassName,
    newClassSections,
    setNewClassSections,
    handleCreateClass,
    handleDeleteClass
  };
}

/**
 * Loads classes the first time a screen that needs them is opened.
 * @param {boolean} enabled
 */
export function useClassesOnDemand(enabled) {
  const { classBook, loadedCollections } = useAdminContext();
  const { fetchClasses } = classBook;
  useEffect(() => {
    if (enabled && !loadedCollections.current.has('classes')) fetchClasses();
  }, [enabled, fetchClasses, loadedCollections]);
}
