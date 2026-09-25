import { useState } from 'react';
import { ArrowRightLeft, Ban, Filter, KeyRound, Lock, RotateCcw, Search, Users } from 'lucide-react';
import {
  Alert, Badge, Button, Card, CardContent, Checkbox, Input, Select, SortableTH, Table, TBody, TD, TH, THead, TR, cn, useSortableData
} from '../../../components/ui';
import { useAdminContext } from '../adminContext';
import { STUDENT_ROSTER_PAGE_SIZE } from '../adminConstants';
import { PagerButtons, pagerNavClass } from '../shared/AdminUi';
import BulkSectionMoveDialog from './BulkSectionMoveDialog';

/**
 * Sort values for the roster columns. The roster RPC pages in student-ID order
 * and has no ordering parameter, so column sorting reorders the current page only.
 * @type {Record<string, (student: import('./useStudentRoster').RosterStudent) => unknown>}
 */
const ROSTER_SORT_ACCESSORS = {
  name: student => student.name,
  studentId: student => student.student_id || student.id,
  class: student => student.class,
  section: student => student.section,
  status: student => (student.archived_at ? 'Inactive' : 'Active')
};

/** @typedef {'' | 'active' | 'inactive'} StatusFilter */

/**
 * Filterable, server-paged roster table with page-level column sorting, bulk
 * deactivation, bulk section moves and per-row account actions.
 * @param {import('./StudentProvisionCard').StudentCardProps} props
 */
export default function StudentRosterCard({ roster, classes }) {
  const { dataLoadState } = useAdminContext();
  const {
    studentsList,
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
    handleResetStudentPassword,
    handleDeactivateStudents,
    handleReactivateStudent,
    handleStudentClassAssignment,
    handleStudentSectionAssignment,
    handleBulkSectionMove
  } = roster;

  const [statusFilter, setStatusFilter] = useState(/** @type {StatusFilter} */ (''));
  // Snapshot taken when the dialog opens: the selection and roster change while the move runs.
  const [moveDialog, setMoveDialog] = useState(/** @type {{ students: import('./useStudentRoster').RosterStudent[], className: string, sections: string[] } | null} */ (null));

  const pageStudents = statusFilter
    ? studentsList.filter(student => (statusFilter === 'inactive') === Boolean(student.archived_at))
    : studentsList;
  const { sortedItems: filteredStudents, sort, requestSort, clearSort } = useSortableData(pageStudents, ROSTER_SORT_ACCESSORS);
  const selectableStudents = filteredStudents.filter(student => !student.archived_at);

  // "Move to section…" needs selected students from exactly one class with another section to move to.
  const selectedRows = studentsList.filter(student => selectedStudents.includes(student.docId) && !student.archived_at);
  const selectedClassNames = [...new Set(selectedRows.map(student => student.class || ''))];
  const moveClass = selectedClassNames.length === 1 && selectedClassNames[0]
    ? classes.find(c => c.name === selectedClassNames[0])
    : undefined;
  const moveSections = moveClass?.sections || [];
  const moveBlockedReason = selectedRows.length === 0
    ? ''
    : selectedClassNames.length !== 1 || !moveClass
      ? 'Select students from one class to move them between sections.'
      : moveSections.length < 2
        ? `Class ${moveClass.name} has only one section.`
        : '';
  const totalPages = Math.max(1, Math.ceil(studentRosterTotal / STUDENT_ROSTER_PAGE_SIZE));
  const confirmedFirstRow = studentRosterTotal === 0 ? 0 : (studentRosterSnapshot.page * STUDENT_ROSTER_PAGE_SIZE) + 1;
  const confirmedLastRow = studentRosterTotal === 0
    ? 0
    : Math.min(studentRosterTotal, confirmedFirstRow + filteredStudents.length - 1);
  const rosterQueryChanged = studentRosterSnapshot.page !== studentRosterPage
    || studentRosterSnapshot.search !== studentSearch
    || studentRosterSnapshot.className !== studentFilterClass
    || studentRosterSnapshot.section !== studentFilterSection;
  const rosterState = dataLoadState.students || /** @type {Partial<import('../../../types').DataLoadEntry>} */ ({});
  const rosterActionsDisabled = rosterQueryChanged || Boolean(rosterState.loading || rosterState.error);

  const applyStudentSearch = () => {
    const nextSearch = studentSearchInput.trim();
    setSelectedStudents([]);
    setStudentRosterPage(0);
    if (nextSearch === studentSearch && studentRosterPage === 0) fetchStudents();
    else setStudentSearch(nextSearch);
  };

  return (
    <Card>
      <CardContent className="flex flex-col gap-4">
        {/* Filter Controls & Bulk Action Bar */}
        <div className="flex flex-wrap items-center gap-3 rounded-xl border border-slate-200 bg-slate-50 p-3">
          <span className="inline-flex items-center gap-1.5 text-sm font-semibold text-slate-700">
            <Filter className="size-4 text-slate-500" aria-hidden="true" /> Filter Roster:
          </span>

          <Input
            type="search"
            aria-label="Search students by name or student ID"
            placeholder="Name or student ID"
            maxLength={100}
            value={studentSearchInput}
            onChange={event => setStudentSearchInput(event.target.value)}
            onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); applyStudentSearch(); } }}
            className="h-9 w-auto min-w-[190px] flex-1"
          />
          <Button variant="secondary" size="sm" className="h-9" onClick={applyStudentSearch}>
            <Search aria-hidden="true" /> Search
          </Button>
          {(studentSearch || studentSearchInput) && (
            <Button variant="ghost" size="sm" className="h-9" onClick={() => {
              setStudentSearchInput('');
              setStudentSearch('');
              setStudentRosterPage(0);
              setSelectedStudents([]);
            }}>Clear search</Button>
          )}

          <div className="min-w-[150px]">
            <Select
              value={studentFilterClass}
              aria-label="Filter roster by class"
              onChange={e => {
                setStudentFilterClass(e.target.value);
                setStudentFilterSection('');
                setStudentRosterPage(0);
                setSelectedStudents([]);
              }}
              className="h-9"
            >
              <option value="">All Classes</option>
              {classes.map(c => <option key={c.id} value={c.name}>{c.name}</option>)}
            </Select>
          </div>

          <div className="min-w-[150px]">
            <Select
              value={studentFilterSection}
              aria-label="Filter roster by section"
              disabled={!studentFilterClass}
              onChange={e => {
                setStudentFilterSection(e.target.value);
                setStudentRosterPage(0);
                setSelectedStudents([]);
              }}
              className="h-9"
            >
              <option value="">All Sections</option>
              {studentFilterClass &&
                (classes.find(c => c.name === studentFilterClass)?.sections || []).map(sec => (
                  <option key={sec} value={sec}>{sec}</option>
                ))
              }
            </Select>
          </div>

          <div className="min-w-[150px]">
            <Select
              value={statusFilter}
              aria-label="Filter this page by status"
              onChange={e => {
                setStatusFilter(/** @type {StatusFilter} */ (e.target.value));
                setSelectedStudents([]);
              }}
              className="h-9"
            >
              <option value="">All Statuses</option>
              <option value="active">Active only</option>
              <option value="inactive">Inactive only</option>
            </Select>
          </div>

          {selectedStudents.length > 0 ? (
            <div className="flex flex-wrap items-center gap-2 sm:ml-auto">
              <Button
                variant="secondary"
                size="sm"
                className="h-9"
                disabled={Boolean(moveBlockedReason) || rosterActionsDisabled}
                aria-describedby={moveBlockedReason ? 'roster-move-blocked-reason' : undefined}
                onClick={() => moveClass && setMoveDialog({ students: selectedRows, className: moveClass.name, sections: moveSections })}
              >
                <ArrowRightLeft aria-hidden="true" /> Move to section…
              </Button>
              <Button
                variant="danger"
                size="sm"
                className="h-9"
                onClick={() => handleDeactivateStudents(selectedStudents)}
              >
                <Ban aria-hidden="true" /> Deactivate Selected ({selectedStudents.length})
              </Button>
            </div>
          ) : null}
          {moveBlockedReason && (
            <p id="roster-move-blocked-reason" className="w-full text-right text-xs text-slate-500">{moveBlockedReason}</p>
          )}
        </div>

        <div role="status" className="flex flex-wrap justify-between gap-3 text-sm text-slate-500">
          <span>Showing confirmed rows {confirmedFirstRow}-{confirmedLastRow} of {studentRosterTotal.toLocaleString()}.</span>
          {(rosterState.loading || rosterQueryChanged) && <span>Loading requested roster page…</span>}
        </div>
        {sort && (
          <p className="-mt-2 flex flex-wrap items-center gap-2 text-xs text-slate-500">
            Sorting reorders the rows on this page only; pages follow student ID order.
            <Button variant="link" size="sm" className="h-auto px-0 text-xs" onClick={clearSort}>Clear sort</Button>
          </p>
        )}
        {rosterQueryChanged && rosterState.error && (
          <Alert variant="danger" role="alert">The table below is the last confirmed page. Row actions are disabled until the requested page loads.</Alert>
        )}

        {/* Student Table */}
        <fieldset disabled={rosterActionsDisabled} aria-busy={rosterState.loading} className="m-0 min-w-0 border-0 p-0">
          <Table stickyHeader scrollLabel="Student roster table">
            <THead>
              <tr>
                <TH className="w-12 text-center">
                  <Checkbox
                    aria-label="Select all active students on this page"
                    checked={selectableStudents.length > 0 && selectedStudents.length === selectableStudents.length}
                    disabled={selectableStudents.length === 0}
                    onChange={(e) => {
                      if (e.target.checked) {
                        setSelectedStudents(selectableStudents.map(s => s.docId));
                      } else {
                        setSelectedStudents([]);
                      }
                    }}
                  />
                </TH>
                <SortableTH sortKey="name" sort={sort} onSort={requestSort}>Student Name</SortableTH>
                <SortableTH sortKey="studentId" sort={sort} onSort={requestSort}>Student ID (Username)</SortableTH>
                <TH>Assigned Password</TH>
                <SortableTH sortKey="class" sort={sort} onSort={requestSort}>Class</SortableTH>
                <SortableTH sortKey="section" sort={sort} onSort={requestSort}>Section</SortableTH>
                <SortableTH sortKey="status" sort={sort} onSort={requestSort}>Status</SortableTH>
                <TH className="text-right">Actions</TH>
              </tr>
            </THead>
            <TBody>
              {filteredStudents.length === 0 ? (
                <tr>
                  <TD colSpan={8} className="py-10 text-center text-slate-500">
                    <span className="inline-flex items-center gap-2"><Users className="size-4 text-slate-400" aria-hidden="true" /> No students match the current filters.</span>
                  </TD>
                </tr>
              ) : filteredStudents.map(student => (
                <TR key={student.docId} className={cn(selectedStudents.includes(student.docId) && 'bg-red-50/60 hover:bg-red-50', student.archived_at && 'text-slate-400')}>
                  <TD className="w-12 text-center">
                    <Checkbox
                      aria-label={`Select ${student.name} on this page`}
                      disabled={Boolean(student.archived_at)}
                      checked={selectedStudents.includes(student.docId)}
                      onChange={(e) => {
                        if (e.target.checked) {
                          setSelectedStudents([...selectedStudents, student.docId]);
                        } else {
                          setSelectedStudents(selectedStudents.filter(id => id !== student.docId));
                        }
                      }}
                      className="disabled:cursor-not-allowed"
                    />
                  </TD>
                  <TD className="font-semibold text-slate-900">{student.name}</TD>
                  <TD className="font-mono text-[13px] font-semibold text-slate-700">{student.student_id || student.id}</TD>
                  <TD>
                    <span className="inline-flex items-center gap-1.5 text-xs text-slate-400" title="Passwords are shown once when issued and are never stored. Use Reset to issue a new one.">
                      <Lock className="size-3.5" aria-hidden="true" /> Hidden · use Reset
                    </span>
                  </TD>
                  <TD className="min-w-[140px]">
                    <Select
                      aria-label={`Class for ${student.name}`}
                      value={student.class || ''}
                      disabled={Boolean(student.archived_at)}
                      onChange={(e) => handleStudentClassAssignment(student, e.target.value)}
                      className="h-8 text-[13px]"
                    >
                      <option value="">N/A</option>
                      {classes.map(c => <option key={c.id} value={c.name}>{c.name}</option>)}
                    </Select>
                  </TD>
                  <TD className="min-w-[110px]">
                    <Select
                      aria-label={`Section for ${student.name}`}
                      value={student.section || ''}
                      disabled={!student.class || Boolean(student.archived_at)}
                      onChange={(e) => handleStudentSectionAssignment(student, e.target.value)}
                      className={cn('h-8 text-[13px]', student.section && 'font-semibold text-brand-700')}
                    >
                      <option value="">N/A</option>
                      {student.class &&
                        (classes.find(c => c.name === student.class)?.sections || []).map(sec => (
                          <option key={sec} value={sec}>{sec}</option>
                        ))
                      }
                    </Select>
                  </TD>
                  <TD>
                    <Badge variant={student.archived_at ? 'danger' : 'success'} title={student.archived_at ? student.archive_reason || 'Inactive' : 'Active'}>
                      {student.archived_at ? 'INACTIVE' : 'ACTIVE'}
                    </Badge>
                  </TD>
                  <TD className="text-right">
                    <div className="inline-flex items-center justify-end gap-1.5">
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => handleResetStudentPassword(student)}
                        disabled={Boolean(student.archived_at)}
                        title="Set or reset student password"
                      >
                        <KeyRound aria-hidden="true" /> Reset
                      </Button>
                      {student.archived_at ? (
                        <Button variant="ghost" size="sm" className="text-emerald-700 hover:bg-emerald-50 hover:text-emerald-800" onClick={() => handleReactivateStudent(student.docId)}>
                          <RotateCcw aria-hidden="true" /> Reactivate
                        </Button>
                      ) : (
                        <Button variant="ghost" size="sm" className="text-red-600 hover:bg-red-50 hover:text-red-700" onClick={() => handleDeactivateStudents([student.docId])}>
                          <Ban aria-hidden="true" /> Deactivate
                        </Button>
                      )}
                    </div>
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </fieldset>
        <nav aria-label="Student roster pages" className={pagerNavClass}>
          <PagerButtons
            page={studentRosterPage + 1}
            totalPages={totalPages}
            prevDisabled={studentRosterPage <= 0 || rosterActionsDisabled}
            nextDisabled={studentRosterPage + 1 >= totalPages || rosterActionsDisabled}
            onPrev={() => {
              setSelectedStudents([]);
              setStudentRosterPage(page => Math.max(0, page - 1));
            }}
            onNext={() => {
              setSelectedStudents([]);
              setStudentRosterPage(page => Math.min(totalPages - 1, page + 1));
            }}
          />
        </nav>
      </CardContent>
      {moveDialog && (
        <BulkSectionMoveDialog
          students={moveDialog.students}
          className={moveDialog.className}
          sections={moveDialog.sections}
          onMove={handleBulkSectionMove}
          onClose={() => setMoveDialog(null)}
        />
      )}
    </Card>
  );
}
