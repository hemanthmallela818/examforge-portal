import { CheckCircle2, ClipboardList } from 'lucide-react';
import { showToast } from '../../../utils';
import { Button } from '../../../components/ui';
import AccessibleModal from '../../../components/AccessibleModal';
import { useAdminContext } from '../adminContext';
import StudentProvisionCard from './StudentProvisionCard';
import StudentRosterCard from './StudentRosterCard';

/**
 * One-time credentials dialog shown after an account is created or its password reset.
 * @param {{ credentials: import('./useStudentRoster').StudentCredentials, onClose: () => void }} props
 */
function CreatedStudentModal({ credentials, onClose }) {
  return (
    <AccessibleModal
      labelledBy="created-student-modal-title"
      onEscape={onClose}
    >
      <div className="w-full max-w-[480px] p-6 text-left">
        <div className="mb-4 flex items-center gap-3">
          <div className="grid size-11 shrink-0 place-items-center rounded-full bg-emerald-50 text-emerald-600 ring-1 ring-emerald-200">
            <CheckCircle2 className="size-6" aria-hidden="true" />
          </div>
          <div>
            <h3 id="created-student-modal-title" className="text-lg font-semibold text-slate-900">
              {credentials.mode === 'reset' ? 'Password Reset' : 'Student Account Created'}
            </h3>
            <p className="mt-0.5 text-sm text-slate-500">
              Share these login credentials with the student. The password is shown only once and is not stored in the portal.
            </p>
          </div>
        </div>

        <dl className="mb-5 flex flex-col gap-3 rounded-xl border border-slate-200 bg-slate-50 p-4">
          <div>
            <dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">Student Name</dt>
            <dd className="text-base font-semibold text-slate-900">{credentials.name}</dd>
          </div>
          <div>
            <dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">Student ID (Login Username)</dt>
            <dd className="font-mono text-base font-bold text-brand-700">{credentials.studentId}</dd>
          </div>
          <div>
            <dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">Assigned Password</dt>
            <dd className="mt-1 inline-block rounded-md border border-slate-300 bg-white px-2.5 py-1 font-mono text-base font-bold text-slate-900">{credentials.password}</dd>
          </div>
          <div>
            <dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">Assigned Class &amp; Section</dt>
            <dd className="text-sm text-slate-700">Class {credentials.className} — Section {credentials.section}</dd>
          </div>
        </dl>

        <div className="flex flex-wrap justify-end gap-2">
          <Button
            onClick={async () => {
              const text = `Student Name: ${credentials.name}\nStudent ID: ${credentials.studentId}\nPassword: ${credentials.password}\nClass: ${credentials.className} (${credentials.section})`;
              await navigator.clipboard.writeText(text);
              showToast('Credentials copied to clipboard!', 'success');
            }}
          >
            <ClipboardList aria-hidden="true" /> Copy All Credentials
          </Button>
          <Button
            variant="secondary"
            onClick={onClose}
          >
            Done
          </Button>
        </div>
      </div>
    </AccessibleModal>
  );
}

/**
 * Student Management tab.
 * @param {{ roster: import('./useStudentRoster').StudentRoster }} props
 */
export default function StudentsView({ roster }) {
  const { classes } = useAdminContext().classBook;
  const { createdStudentModal, setCreatedStudentModal } = roster;
  return (
    <div className="animate-fade-in flex flex-col gap-6">
      {/* Add Student Form */}
      <StudentProvisionCard roster={roster} classes={classes} />
      <StudentRosterCard roster={roster} classes={classes} />

      {createdStudentModal && (
        <CreatedStudentModal credentials={createdStudentModal} onClose={() => setCreatedStudentModal(null)} />
      )}
    </div>
  );
}
