import { useState } from 'react';
import { Plus, School, Search, Trash2 } from 'lucide-react';
import {
  Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, EmptyState, Field, Input,
  SortableTH, Table, TBody, TD, TH, THead, TR, useSortableData
} from '../../../components/ui';
import { useAdminContext } from '../adminContext';

/** @type {Record<string, (cls: import('../../../types').ClassRow) => unknown>} */
const CLASS_SORT_ACCESSORS = {
  name: cls => cls.name,
  sections: cls => (cls.sections || []).length
};

/** Class Management tab. */
export default function ClassesView() {
  const {
    classes,
    newClassName,
    setNewClassName,
    newClassSections,
    setNewClassSections,
    handleCreateClass,
    handleDeleteClass
  } = useAdminContext().classBook;

  // The full class list is loaded, so filtering and sorting here cover every class.
  const [classFilter, setClassFilter] = useState('');
  const needle = classFilter.trim().toLowerCase();
  const visibleClasses = needle
    ? classes.filter(cls => cls.name.toLowerCase().includes(needle)
      || (cls.sections || []).some(section => section.toLowerCase() === needle))
    : classes;
  const { sortedItems, sort, requestSort } = useSortableData(visibleClasses, CLASS_SORT_ACCESSORS, { key: 'name', direction: 'asc' });

  return (
    <Card className="animate-fade-in">
      <CardHeader>
        <div>
          <CardTitle as="h2"><School aria-hidden="true" /> Class Management</CardTitle>
          <CardDescription>Create classes and their sections. Only empty classes can be deleted.</CardDescription>
        </div>
        <Badge variant="neutral" className="tabular-nums">{classes.length} class{classes.length === 1 ? '' : 'es'}</Badge>
      </CardHeader>
      <CardContent className="flex flex-col gap-6">
        <div className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
          <Field label="Class name" htmlFor="new-class-name">
            <Input
              id="new-class-name"
              type="text"
              placeholder="Class Name (e.g. Class 10)"
              value={newClassName}
              onChange={e => setNewClassName(e.target.value)}
              onKeyDown={async (e) => { if (e.key === 'Enter') { e.preventDefault(); await handleCreateClass(); } }}
            />
          </Field>
          <Field label="Sections" htmlFor="new-class-sections">
            <Input
              id="new-class-sections"
              type="text"
              placeholder="Sections (comma-separated, e.g. A, B, C)"
              value={newClassSections}
              onChange={e => setNewClassSections(e.target.value)}
              onKeyDown={async (e) => { if (e.key === 'Enter') { e.preventDefault(); await handleCreateClass(); } }}
            />
          </Field>
          <Button onClick={handleCreateClass}><Plus aria-hidden="true" /> Create Class</Button>
        </div>

        {classes.length === 0 ? (
          <EmptyState icon={School} title="No classes found" description="No classes found. Create one above!" />
        ) : (
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-3">
              <div className="relative w-full sm:max-w-xs">
                <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-slate-400" aria-hidden="true" />
                <Input
                  type="search"
                  aria-label="Filter classes by name or section"
                  placeholder="Filter by class or section"
                  value={classFilter}
                  onChange={e => setClassFilter(e.target.value)}
                  className="h-9 pl-9"
                />
              </div>
              {needle && (
                <span role="status" className="text-sm text-slate-500 tabular-nums">
                  Showing {visibleClasses.length} of {classes.length}
                </span>
              )}
            </div>
            <Table stickyHeader scrollLabel="Classes table">
              <THead>
                <tr>
                  <SortableTH sortKey="name" sort={sort} onSort={requestSort}>Class Name</SortableTH>
                  <SortableTH sortKey="sections" sort={sort} onSort={requestSort}>Sections</SortableTH>
                  <TH className="text-right">Actions</TH>
                </tr>
              </THead>
              <TBody>
                {sortedItems.length === 0 && (
                  <tr>
                    <TD colSpan={3} className="py-8 text-center text-slate-500">No classes match this filter.</TD>
                  </tr>
                )}
                {sortedItems.map(cls => (
                  <TR key={cls.id}>
                    <TD className="font-semibold text-slate-900">{cls.name}</TD>
                    <TD>
                      <div className="flex flex-wrap gap-1.5">
                        {(cls.sections || []).map(sec => (
                          <Badge key={sec} variant="brand">{sec}</Badge>
                        ))}
                      </div>
                    </TD>
                    <TD className="text-right">
                      <Button variant="ghost" size="sm" className="text-red-600 hover:bg-red-50 hover:text-red-700" onClick={() => handleDeleteClass(cls.id)}>
                        <Trash2 aria-hidden="true" /> Delete
                      </Button>
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
