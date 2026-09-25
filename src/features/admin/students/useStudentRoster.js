import { useCallback, useEffect, useRef, useState } from 'react';
import { customAlert, customConfirm, customPrompt, showToast } from '../../../utils';
import { supabase } from '../../../supabase';
import { parsePagedCollectionResponse } from '../../../paginatedQuery';
import { readFunctionInvocationError } from '../../../edgeFunctionErrors';
import { useAdminContext } from '../adminContext';
import { STUDENT_ROSTER_PAGE_SIZE } from '../adminConstants';

/**
 * A roster row as rendered by the admin screens: the RPC row plus `docId`
 * (auth user id) and `id` (the student login id).
 * @typedef {object} RosterStudent
 * @property {string} docId
 * @property {string} id
 * @property {string} student_id
 * @property {string} name
 * @property {string | null} [class]
 * @property {string | null} [section]
 * @property {string | null} [archived_at]
 * @property {string | null} [archive_reason]
 */

/**
 * Credentials shown once after an account is created or its password reset.
 * @typedef {object} StudentCredentials
 * @property {'created' | 'reset'} mode
 * @property {string} name
 * @property {string} studentId
 * @property {string} password
 * @property {string | null | undefined} className
 * @property {string | null | undefined} section
 */

/** @typedef {{ page: number, search: string, className: string, section: string }} RosterQuery */

/**
 * Outcome of a bulk section move. `failed` students stay selected so the
 * administrator can retry them.
 * @typedef {object} BulkMoveResult
 * @property {RosterStudent[]} moved
 * @property {RosterStudent[]} unchanged students already in the target section
 * @property {Array<{ student: RosterStudent, message: string }>} failed
 */

/** Parallel Edge Function calls during a bulk move; small so the server is not flooded. */
export const BULK_MOVE_CONCURRENCY = 3;
/** @typedef {ReturnType<typeof useStudentRoster>} StudentRoster */

/**
 * Server-paged student roster plus account provisioning, password reset,
 * class/section reassignment and (re)activation. Loads while `enabled`.
 * @param {{ enabled: boolean }} options
 */
export function useStudentRoster({ enabled }) {
  const { runAdminDataLoad, scheduleTableCounts, loadedCollections, classBook } = useAdminContext();
  const { classes } = classBook;

  const [studentsList, setStudentsList] = useState(/** @type {RosterStudent[]} */ ([]));
  const [selectedStudents, setSelectedStudents] = useState(/** @type {string[]} */ ([]));
  const [studentFilterClass, setStudentFilterClass] = useState('');
  const [studentFilterSection, setStudentFilterSection] = useState('');
  const [studentSearchInput, setStudentSearchInput] = useState('');
  const [studentSearch, setStudentSearch] = useState('');
  const [studentRosterPage, setStudentRosterPage] = useState(0);
  const [studentRosterTotal, setStudentRosterTotal] = useState(0);
  const [studentRosterSnapshot, setStudentRosterSnapshot] = useState(/** @type {RosterQuery} */ ({ page: 0, search: '', className: '', section: '' }));

  const [newStudentName, setNewStudentName] = useState('');
  const [newStudentId, setNewStudentId] = useState('');
  const [newStudentPassword, setNewStudentPassword] = useState('');
  const [showNewStudentPassword, setShowNewStudentPassword] = useState(false);
  const [isAddingStudent, setIsAddingStudent] = useState(false);
  const [selectedStudentClass, setSelectedStudentClass] = useState('');
  const [selectedStudentSection, setSelectedStudentSection] = useState('');
  const [createdStudentModal, setCreatedStudentModal] = useState(/** @type {StudentCredentials | null} */ (null));

  // Read by the Realtime subscription (see useAdminRealtime).
  const locallyAddedStudents = useRef(/** @type {Set<string>} */ (new Set()));
  const studentsListRef = useRef(/** @type {RosterStudent[]} */ ([]));
  const studentRosterQueryRef = useRef(/** @type {RosterQuery} */ ({ page: 0, search: '', className: '', section: '' }));

  useEffect(() => {
    studentsListRef.current = studentsList;
  }, [studentsList]);

  useEffect(() => {
    studentRosterQueryRef.current = {
      page: studentRosterPage,
      search: studentSearch,
      className: studentFilterClass,
      section: studentFilterSection
    };
  }, [studentRosterPage, studentSearch, studentFilterClass, studentFilterSection]);

  const fetchStudents = useCallback(async () => {
    const query = { ...studentRosterQueryRef.current };
    const result = await runAdminDataLoad('students', 'The student roster page could not be loaded. Existing entries may be stale or incomplete.', async () => {
      const { data, error } = await supabase.rpc('get_admin_student_roster_page', {
        page_number_param: query.page,
        page_size_param: STUDENT_ROSTER_PAGE_SIZE,
        search_param: query.search || null,
        class_param: query.className || null,
        section_param: query.section || null
      });
      if (error) throw error;
      return parsePagedCollectionResponse(data, {
        expectedPage: query.page,
        expectedPageSize: STUDENT_ROSTER_PAGE_SIZE
      });
    });
    if (!result.ok || !result.current) return result.ok;
    const data = result.data;
    setStudentsList(data.rows.map((/** @type {import('../../../types').UntrustedInput} */ s) => ({ ...s, docId: s.id, id: s.student_id, student_id: s.student_id })));
    setStudentRosterTotal(data.total);
    setStudentRosterSnapshot(query);
    const lastPage = Math.max(0, Math.ceil(data.total / STUDENT_ROSTER_PAGE_SIZE) - 1);
    if (data.page > lastPage) setStudentRosterPage(lastPage);
    loadedCollections.current.add('students');
    scheduleTableCounts();
    return true;
  }, [runAdminDataLoad, scheduleTableCounts, loadedCollections]);

  // The roster (re)loads whenever the Students tab is opened or its query changes.
  useEffect(() => {
    if (!enabled) return;
    fetchStudents();
  }, [enabled, fetchStudents, studentRosterPage, studentSearch, studentFilterClass, studentFilterSection]);

  /** @param {string} className */
  const handleClassChange = (className) => {
    setSelectedStudentClass(className);
    const cls = classes.find(c => c.name === className);
    if (cls && cls.sections && cls.sections.length > 0) {
      setSelectedStudentSection(cls.sections[0]);
    } else {
      setSelectedStudentSection('');
    }
  };

  const handleAddStudent = async () => {
    if (isAddingStudent) return;
    if (!newStudentName.trim() || !newStudentId.trim() || !newStudentPassword || !selectedStudentClass || !selectedStudentSection) {
      await customAlert("Please fill in all student details: Name, ID, Password, Class, and Section.");
      return;
    }

    if (newStudentPassword.length < 12) {
      await customAlert("Student password must contain at least 12 characters.");
      return;
    }

    const trimmedId = newStudentId.trim();
    const trimmedName = newStudentName.trim();

    // Check against real-time local list (case-insensitive)
    const isDuplicate = studentsList.some(
      s => s.id && s.id.trim().toLowerCase() === trimmedId.toLowerCase()
    );

    if (isDuplicate) {
      await customAlert(`A student with ID "${trimmedId}" already exists!`);
      return;
    }

    // Double check directly with Supabase
    setIsAddingStudent(true);
    try {
      const { data: existing, error: duplicateCheckError } = await supabase
        .from('students')
        .select('id')
        .eq('student_id', trimmedId);
      if (duplicateCheckError) throw duplicateCheckError;
      if (existing && existing.length > 0) {
        await customAlert(`A student with ID "${trimmedId}" already exists in the database!`);
        return;
      }

      // Record local addition to suppress duplicate realtime toast
      locallyAddedStudents.current.add(trimmedId.toLowerCase());
      locallyAddedStudents.current.add(trimmedName.toLowerCase());

      const { error: createError } = await supabase.functions.invoke('manage-student', {
        body: {
          action: 'create',
          studentId: trimmedId,
          name: trimmedName,
          password: newStudentPassword,
          className: selectedStudentClass,
          section: selectedStudentSection
        }
      });
      if (createError) throw createError;

      setCreatedStudentModal({
        mode: 'created',
        name: trimmedName,
        studentId: trimmedId,
        password: newStudentPassword,
        className: selectedStudentClass,
        section: selectedStudentSection
      });

      setNewStudentName('');
      setNewStudentId('');
      setNewStudentPassword('');
      setShowNewStudentPassword(false);
      setSelectedStudentClass('');
      setSelectedStudentSection('');
      showToast(`Student "${trimmedName}" added successfully.`, "success");
    } catch (err) {
      console.error("Error adding student:", err);
      locallyAddedStudents.current.delete(trimmedId.toLowerCase());
      locallyAddedStudents.current.delete(trimmedName.toLowerCase());
      await customAlert("Failed to add student: " + /** @type {Error} */ (err).message);
    } finally {
      setIsAddingStudent(false);
    }
  };

  /** @param {RosterStudent} student */
  const handleResetStudentPassword = async (student) => {
    const studentUsername = student.student_id || student.id;
    const rawNewPass = await customPrompt(`Enter a new password (min 12 characters) for student "${student.name}" (ID: ${studentUsername}):`);
    if (rawNewPass === null) return;
    const newPass = rawNewPass.trim();
    if (newPass.length < 12 || newPass.length > 128) {
      await customAlert("Password must be between 12 and 128 characters.");
      return;
    }
    try {
      const { error } = await supabase.functions.invoke('manage-student', {
        body: {
          action: 'reset-student-password',
          studentUserId: student.docId,
          password: newPass
        }
      });
      if (error) throw error;
      setCreatedStudentModal({
        mode: 'reset',
        name: student.name,
        studentId: studentUsername,
        password: newPass,
        className: student.class,
        section: student.section
      });
      showToast(`Password updated for ${student.name}.`, 'success');
    } catch (err) {
      console.error('Password reset failed:', err);
      await customAlert(`Failed to reset password: ${/** @type {Error} */ (err).message}`);
    }
  };

  /** @param {string[]} studentIds */
  const handleDeactivateStudents = async (studentIds) => {
    const activeIds = studentIds.filter(id => !studentsList.find(student => student.docId === id)?.archived_at);
    if (activeIds.length === 0) return;
    const reason = await customPrompt('Enter the reason for deactivating the selected student account(s):');
    if (reason === null) return;
    if (reason.trim().length < 3 || reason.trim().length > 500) {
      await customAlert('A deactivation reason between 3 and 500 characters is required.');
      return;
    }
    if (!await customConfirm(`Deactivate ${activeIds.length} student account(s)? Their examination results will be retained.`)) return;
    try {
      const { error } = await supabase.rpc('admin_deactivate_students', {
        user_ids_param: activeIds,
        reason_param: reason
      });
      if (error) throw error;
      setSelectedStudents([]);
      showToast(`${activeIds.length} student account(s) deactivated.`, 'success');
      await fetchStudents();
    } catch (err) {
      console.error('Error deactivating students:', err);
      await customAlert(`Student deactivation failed: ${/** @type {Error} */ (err).message}`);
    }
  };

  /** @param {string} docId */
  const handleReactivateStudent = async (docId) => {
    if (!await customConfirm('Reactivate this student account?')) return;
    try {
      const { error } = await supabase.rpc('admin_reactivate_students', { user_ids_param: [docId] });
      if (error) throw error;
      showToast('Student account reactivated.', 'success');
      await fetchStudents();
    } catch (err) {
      console.error('Error reactivating student:', err);
      await customAlert(`Student reactivation failed: ${/** @type {Error} */ (err).message}`);
    }
  };

  /**
   * The trusted assignment path: the manage-student Edge Function validates the
   * class/section, updates the account and writes the audit record server-side.
   * @param {RosterStudent} student
   * @param {string | null | undefined} className
   * @param {string} section
   */
  const invokeAssignmentUpdate = (student, className, section) => supabase.functions.invoke('manage-student', {
    body: {
      action: 'update-assignment',
      studentUserId: student.docId,
      className,
      section,
    }
  });

  /**
   * Moves the selected active students of one class to `targetSection`, one
   * update-assignment call per student (at most BULK_MOVE_CONCURRENCY at a time).
   * Reports progress after every student, reloads the roster page afterwards and
   * leaves only the failed students selected.
   * @param {string[]} studentIds
   * @param {string} targetSection
   * @param {(progress: { done: number, total: number }) => void} [onProgress]
   * @returns {Promise<BulkMoveResult>}
   */
  const handleBulkSectionMove = async (studentIds, targetSection, onProgress) => {
    const students = studentIds
      .map(id => studentsList.find(student => student.docId === id))
      .filter(/** @returns {student is RosterStudent} */ student => Boolean(student && !student.archived_at));
    const classNames = new Set(students.map(student => student.class || ''));
    const className = students[0]?.class || '';
    const matchedClass = classes.find(c => c.name === className);
    if (students.length === 0 || classNames.size !== 1 || !matchedClass || !(matchedClass.sections || []).includes(targetSection)) {
      throw new Error('Select active students from a single class and a section of that class.');
    }

    /** @type {BulkMoveResult} */
    const result = { moved: [], unchanged: [], failed: [] };
    const pending = students.filter(student => {
      if (student.section === targetSection) {
        result.unchanged.push(student);
        return false;
      }
      return true;
    });
    const total = students.length;
    let done = result.unchanged.length;
    onProgress?.({ done, total });

    let cursor = 0;
    const worker = async () => {
      while (cursor < pending.length) {
        const student = pending[cursor++];
        try {
          const response = await invokeAssignmentUpdate(student, className, targetSection);
          if (response?.error) throw new Error(await readFunctionInvocationError(response, 'The server rejected the update.'));
          result.moved.push(student);
        } catch (err) {
          result.failed.push({ student, message: /** @type {Error} */ (err)?.message || 'The server rejected the update.' });
        }
        done += 1;
        onProgress?.({ done, total });
      }
    };
    await Promise.all(Array.from({ length: Math.min(BULK_MOVE_CONCURRENCY, pending.length) }, worker));

    // Keep the roster's order for the failure list.
    const order = new Map(students.map((student, index) => [student.docId, index]));
    result.failed.sort((a, b) => (order.get(a.student.docId) ?? 0) - (order.get(b.student.docId) ?? 0));

    setSelectedStudents(result.failed.map(entry => entry.student.docId));
    if (result.moved.length > 0) {
      showToast(`${result.moved.length} student(s) moved to Section ${targetSection}.`, result.failed.length > 0 ? 'warning' : 'success');
      await fetchStudents();
    }
    return result;
  };

  /**
   * @param {RosterStudent} student
   * @param {string} newClass
   */
  const handleStudentClassAssignment = async (student, newClass) => {
    const matchedClass = classes.find(c => c.name === newClass);
    const defaultSection = matchedClass && matchedClass.sections && matchedClass.sections.length > 0 ? matchedClass.sections[0] : '';
    try {
      if (!newClass || !defaultSection) throw new Error('Select a class with a valid section.');
      const { error } = await invokeAssignmentUpdate(student, newClass, defaultSection);
      if (error) throw error;
      showToast("Student class updated.", "success");
    } catch (err) {
      console.error(err);
      await customAlert("Failed to update student class.");
    }
  };

  /**
   * @param {RosterStudent} student
   * @param {string} newSection
   */
  const handleStudentSectionAssignment = async (student, newSection) => {
    try {
      if (!newSection) throw new Error('Select a valid section.');
      const { error } = await invokeAssignmentUpdate(student, student.class, newSection);
      if (error) throw error;
      showToast("Student section updated.", "success");
    } catch (err) {
      console.error(err);
      await customAlert("Failed to update student section.");
    }
  };

  return {
    studentsList,
    studentsListRef,
    locallyAddedStudents,
    fetchStudents,
    selectedStudents,
    setSelectedStudents,
    studentFilterClass,
    setStudentFilterClass,
    studentFilterSection,
    setStudentFilterSection,
    studentSearchInput,
    setStudentSearchInput,
    studentSearch,
    setStudentSearch,
    studentRosterPage,
    setStudentRosterPage,
    studentRosterTotal,
    studentRosterSnapshot,
    newStudentName,
    setNewStudentName,
    newStudentId,
    setNewStudentId,
    newStudentPassword,
    setNewStudentPassword,
    showNewStudentPassword,
    setShowNewStudentPassword,
    isAddingStudent,
    selectedStudentClass,
    selectedStudentSection,
    setSelectedStudentSection,
    createdStudentModal,
    setCreatedStudentModal,
    handleClassChange,
    handleAddStudent,
    handleResetStudentPassword,
    handleDeactivateStudents,
    handleReactivateStudent,
    handleStudentClassAssignment,
    handleStudentSectionAssignment,
    handleBulkSectionMove
  };
}
