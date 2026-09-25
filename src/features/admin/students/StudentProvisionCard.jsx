import { Eye, EyeOff, UserPlus } from 'lucide-react';
import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Field, Input, Select } from '../../../components/ui';

/**
 * @typedef {object} StudentCardProps
 * @property {import('./useStudentRoster').StudentRoster} roster
 * @property {import('../../../types').ClassRow[]} classes
 */

/**
 * "Student Roster" card: provisions a student sign-in account in a class and section.
 * @param {StudentCardProps} props
 */
export default function StudentProvisionCard({ roster, classes }) {
  const {
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
    handleClassChange,
    handleAddStudent
  } = roster;

  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle as="h2"><UserPlus aria-hidden="true" /> Student Roster</CardTitle>
          <CardDescription>Provision a student sign-in account and assign it to a class and section.</CardDescription>
        </div>
      </CardHeader>
      <CardContent>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-[repeat(5,minmax(0,1fr))_auto] xl:items-end">
          <Field label="Name" htmlFor="new-student-name">
            <Input id="new-student-name" type="text" placeholder="Student Name" value={newStudentName} onChange={e => setNewStudentName(e.target.value)} onKeyDown={async (e) => { if (e.key === 'Enter') { e.preventDefault(); await handleAddStudent(); } }} />
          </Field>
          <Field label="Login ID" htmlFor="new-student-id">
            <Input id="new-student-id" type="text" placeholder="Student ID (Login ID)" value={newStudentId} onChange={e => setNewStudentId(e.target.value)} onKeyDown={async (e) => { if (e.key === 'Enter') { e.preventDefault(); await handleAddStudent(); } }} />
          </Field>
          <Field label="Initial password" htmlFor="new-student-password">
            <div className="relative">
              <Input
                id="new-student-password"
                type={showNewStudentPassword ? "text" : "password"}
                autoComplete="new-password"
                aria-label="Initial student password"
                placeholder="Password (12+ characters)"
                value={newStudentPassword}
                onChange={e => setNewStudentPassword(e.target.value)}
                onKeyDown={async (e) => { if (e.key === 'Enter') { e.preventDefault(); await handleAddStudent(); } }}
                className="pr-10"
              />
              <button
                type="button"
                onClick={() => setShowNewStudentPassword(prev => !prev)}
                aria-label={showNewStudentPassword ? "Hide password" : "Show password"}
                title={showNewStudentPassword ? "Hide password" : "Show password"}
                className="absolute right-1.5 top-1/2 grid size-7 -translate-y-1/2 cursor-pointer place-items-center rounded-md text-slate-500 hover:bg-slate-100 hover:text-slate-700"
              >
                {showNewStudentPassword ? <EyeOff className="size-4" aria-hidden="true" /> : <Eye className="size-4" aria-hidden="true" />}
              </button>
            </div>
          </Field>

          <Field label="Class" htmlFor="new-student-class">
            <Select
              id="new-student-class"
              value={selectedStudentClass}
              onChange={e => handleClassChange(e.target.value)}
            >
              <option value="">Select Class...</option>
              {classes.map(c => <option key={c.id} value={c.name}>{c.name}</option>)}
            </Select>
          </Field>

          <Field label="Section" htmlFor="new-student-section">
            <Select
              id="new-student-section"
              value={selectedStudentSection}
              disabled={!selectedStudentClass}
              onChange={e => setSelectedStudentSection(e.target.value)}
            >
              <option value="">Select Section...</option>
              {selectedStudentClass &&
                (classes.find(c => c.name === selectedStudentClass)?.sections || []).map(sec => (
                  <option key={sec} value={sec}>{sec}</option>
                ))
              }
            </Select>
          </Field>

          <Button onClick={handleAddStudent} loading={isAddingStudent} className="sm:col-span-2 lg:col-span-1">
            {!isAddingStudent && <UserPlus aria-hidden="true" />}
            {isAddingStudent ? 'Adding…' : 'Add Student'}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
