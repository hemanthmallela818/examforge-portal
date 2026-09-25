import { AlertTriangle, Archive, CheckCircle2, HardDrive, Info, Lightbulb, Lock, ShieldAlert, Trash2 } from 'lucide-react';
import { Alert, Badge, Button, Card, CardContent, CardDescription, CardHeader, cn } from './ui';

/**
 * @typedef {object} MaintainedTable
 * @property {keyof import('../types').TableCounts} key
 * @property {string} name
 * @property {string} desc
 * @property {string} warning
 * @property {boolean} [rootOnly]
 * @property {string} [rootActionLabel]
 * @property {string} [actionLabel]
 * @property {boolean} [protected]
 */

/** @type {MaintainedTable[]} */
const TABLE_METADATA = [
  {
    key: 'student_results',
    name: 'Exam Results',
    desc: 'Permanent academic records for submitted examinations.',
    warning: 'Root developer only: download/export results first, then clear them independently. Student accounts are preserved.',
    rootOnly: true,
    rootActionLabel: 'Clear Exam Results'
  },
  {
    key: 'active_sessions',
    name: 'Active Student Sessions',
    desc: 'Contains backing store backups for student exam progress, allowing students to restore their tests in case of accidental browser closures or power cuts.',
    warning: 'Expired attempts are graded from their last server-confirmed answers. Unexpired attempts are never removed.',
    actionLabel: 'Finalize Expired Attempts'
  },
  {
    key: 'cbt_exams',
    name: 'Exams & Schedules',
    desc: 'Contains all scheduled exams, test papers, and their targeting classes/sections.',
    warning: 'Root developer only: clear results and active sessions first. Student accounts and classes remain.',
    rootOnly: true,
    rootActionLabel: 'Clear Exams & Schedules'
  },
  {
    key: 'question_bank',
    name: 'Question Bank',
    desc: 'The central directory holding all imported JEE questions and MCQ choices.',
    warning: 'Root developer only: clearing removes reusable questions; exam snapshots and image assets remain intact.',
    rootOnly: true,
    rootActionLabel: 'Clear Question Bank'
  },
  {
    key: 'students',
    name: 'Student Roster',
    desc: 'Contains the roster information linked to student sign-in accounts.',
    warning: 'Protected: accounts are deactivated reversibly and examination results are retained.',
    protected: true
  },
  {
    key: 'classes',
    name: 'Classes & Sections',
    desc: 'Lists the classes (e.g. Class 10) and sections (A, B, C) available to organize students and target exams.',
    warning: 'Protected: only an empty, unreferenced class can be deleted individually.',
    protected: true
  },
  {
    key: 'import_history',
    name: 'Reviewed JSON Import History',
    desc: 'Maintains audit history of completed reviewed JSON question imports.',
    warning: 'Protected: retained as an operational audit record.',
    protected: true
  }
];

/**
 * @typedef {object} AdminDatabaseCleanerViewProps
 * @property {number | null} dbSize Total database size in bytes (null until known).
 * @property {(bytes: number) => string} formatBytes
 * @property {import('../types').TableCounts} tableCounts
 * @property {(tableName: string, tableDisplayName: string) => unknown} onMaintainTable
 * @property {boolean} isRootDeveloper
 * @property {() => unknown} onResetApplication
 * @property {boolean} isResetting
 */

/** @param {AdminDatabaseCleanerViewProps} props */
const AdminDatabaseCleanerView = ({
  dbSize,
  formatBytes,
  tableCounts,
  onMaintainTable,
  isRootDeveloper,
  onResetApplication,
  isResetting
}) => (
  <div className="animate-fade-in flex flex-col gap-6">
    {isRootDeveloper && (
      <Card as="section" aria-labelledby="root-reset-title" className="overflow-hidden border-red-200 ring-1 ring-red-100">
        <div className="flex flex-wrap items-start gap-4 border-b border-red-100 bg-red-50/70 px-6 py-4">
          <div className="grid size-10 shrink-0 place-items-center rounded-xl bg-red-100 text-red-700 ring-1 ring-red-200">
            <ShieldAlert className="size-5" aria-hidden="true" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-xs font-semibold uppercase tracking-wide text-red-700">Danger zone</p>
            <h3 id="root-reset-title" className="text-base font-semibold text-red-900">Root Developer Reset (Full Installation — Optional)</h3>
          </div>
        </div>
        <CardContent className="space-y-3">
          <p className="text-sm leading-relaxed text-slate-700">
            This removes all student accounts and application data in one operation. For normal reuse, use the separate root-only buttons below instead.
            Your root account and administrator accounts are preserved.
          </p>
          <p className="text-sm text-slate-500">
            This includes results, exams, sessions, students, classes, questions, imports, and previous audit events. Private Storage files are not removed.
          </p>
          <Button
            variant="danger"
            size="lg"
            className={cn('mt-2 w-full', isResetting && 'cursor-wait')}
            onClick={onResetApplication}
            disabled={isResetting}
          >
            <AlertTriangle aria-hidden="true" />
            {isResetting ? 'Resetting Application Data…' : 'Reset Application Data'}
          </Button>
        </CardContent>
      </Card>
    )}

    <Card>
      <CardHeader className="items-center">
        <div className="flex min-w-0 items-start gap-3">
          <div className="grid size-10 shrink-0 place-items-center rounded-xl bg-brand-50 text-brand-600 ring-1 ring-brand-100">
            <HardDrive className="size-5" aria-hidden="true" />
          </div>
          <div className="min-w-0">
            <h3 className="text-base font-semibold text-slate-900">Supabase Database Storage</h3>
            <CardDescription className="mt-0.5">Current PostgreSQL database size reported by the server.</CardDescription>
          </div>
        </div>
        <div className="text-right">
          <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Database size</p>
          <p className="text-2xl font-semibold tracking-tight text-brand-700 tabular-nums">
            {Number.isFinite(dbSize) ? formatBytes(/** @type {number} */ (dbSize)) : 'Not loaded'}
          </p>
        </div>
      </CardHeader>
      <CardContent className="space-y-2 text-sm leading-relaxed text-slate-500">
        <p>
          Storage capacity and remaining quota depend on the configured Supabase plan. Verify quota and alerts in the provider dashboard before an examination window.
        </p>
        <p>
          After a cleanup, the size shown here may stay similar for a while. PostgreSQL keeps the freed space and reuses it for new data, so row counts below are the reliable proof that data was removed.
        </p>
      </CardContent>
    </Card>

    <Alert variant="warning" icon={Lightbulb} title="Maintain Storage Efficiency">
      The root developer can clear results, exams, and reusable questions separately. Student accounts and administrator accounts are never removed by these buttons.
    </Alert>

    <div className="grid gap-5 md:grid-cols-2 xl:grid-cols-3">
      {TABLE_METADATA.map(table => {
        const isLocked = table.protected || (table.rootOnly && !isRootDeveloper);
        const isRootClear = !isLocked && isRootDeveloper && table.rootActionLabel;
        return (
          <Card key={table.key} className="flex flex-col">
            <CardContent className="flex flex-1 flex-col">
              <div className="mb-2 flex items-start justify-between gap-3">
                <h4 className="text-base font-semibold text-slate-900">{table.name}</h4>
                <Badge variant={tableCounts[table.key] === null ? 'neutral' : 'brand'} className="tabular-nums">
                  {tableCounts[table.key] === null ? 'Not loaded' : `${tableCounts[table.key]} rows`}
                </Badge>
              </div>
              <p className="mb-4 text-sm leading-relaxed text-slate-500">{table.desc}</p>
              <div className="mb-5 mt-auto flex items-start gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2.5 text-xs font-medium leading-relaxed text-slate-600">
                <Info className="mt-0.5 size-3.5 shrink-0 text-slate-400" aria-hidden="true" />
                <span>{table.warning}</span>
              </div>
              <Button
                variant={isRootClear ? 'danger-outline' : 'secondary'}
                className="w-full"
                onClick={() => onMaintainTable(table.key, table.name)}
                disabled={table.protected || (table.rootOnly && !isRootDeveloper)}
              >
                {table.protected
                  ? <><Lock aria-hidden="true" /> Protected Record</>
                  : (table.rootOnly && !isRootDeveloper
                    ? <><Lock aria-hidden="true" /> Root Developer Only</>
                    : (isRootDeveloper && table.rootActionLabel
                      ? <><Trash2 aria-hidden="true" /> {table.rootActionLabel}</>
                      : table.actionLabel
                        ? <><CheckCircle2 aria-hidden="true" /> {table.actionLabel}</>
                        : <><Archive aria-hidden="true" /> {`Maintain ${table.name}`}</>))}
              </Button>
            </CardContent>
          </Card>
        );
      })}
    </div>
  </div>
);

export default AdminDatabaseCleanerView;
