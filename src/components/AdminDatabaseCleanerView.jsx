
const TABLE_METADATA = [
  {
    key: 'student_results',
    name: 'Exam Results',
    desc: 'Permanent academic records for submitted examinations.',
    warning: 'Protected: submitted results cannot be modified or deleted by the application.',
    protected: true
  },
  {
    key: 'active_sessions',
    name: 'Active Student Sessions',
    desc: 'Contains backing store backups for student exam progress, allowing students to restore their tests in case of accidental browser closures or power cuts.',
    warning: 'Expired attempts are graded from their last server-confirmed answers. Unexpired attempts are never removed.',
    actionLabel: '✅ Finalize Expired Attempts'
  },
  {
    key: 'cbt_exams',
    name: 'Exams & Schedules',
    desc: 'Contains all scheduled exams, test papers, and their targeting classes/sections.',
    warning: 'Protected: bulk deletion is disabled. Only an unused exam can be deleted individually.',
    protected: true
  },
  {
    key: 'question_bank',
    name: 'Question Bank',
    desc: 'The central directory holding all imported JEE questions and MCQ choices.',
    warning: 'Clearing removes reusable questions, but existing exam snapshots and image assets remain intact.',
    actionLabel: '🧹 Clear Question Bank'
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

const AdminDatabaseCleanerView = ({
  dbSize,
  formatBytes,
  tableCounts,
  onMaintainTable,
  isRootDeveloper,
  onResetApplication,
  isResetting
}) => (
  <div className="animate-fade-in" style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
    {isRootDeveloper && (
      <section aria-labelledby="root-reset-title" style={{ backgroundColor: '#fff7f7', padding: '24px', borderRadius: '12px', border: '2px solid #dc2626' }}>
        <h3 id="root-reset-title" style={{ margin: '0 0 8px', color: '#991b1b' }}>Root Developer Reset</h3>
        <p style={{ margin: '0 0 10px', color: '#7f1d1d', lineHeight: 1.5 }}>
          Permanently removes all student accounts and application data so this installation can be reused.
          Your root account and administrator accounts are preserved.
        </p>
        <p style={{ margin: '0 0 18px', color: '#7f1d1d', fontSize: '0.85rem' }}>
          This includes results, exams, sessions, students, classes, questions, imports, and previous audit events. Private Storage files are not removed.
        </p>
        <button
          type="button"
          onClick={onResetApplication}
          disabled={isResetting}
          style={{
            width: '100%', padding: '12px', borderRadius: '6px', border: 0,
            backgroundColor: '#b91c1c', color: 'white', fontWeight: 'bold',
            cursor: isResetting ? 'wait' : 'pointer', opacity: isResetting ? 0.65 : 1
          }}
        >
          {isResetting ? 'Resetting Application Data…' : '⚠ Reset Application Data'}
        </button>
      </section>
    )}
    <div style={{ backgroundColor: 'var(--panel-bg)', padding: '30px', borderRadius: '12px', border: '1px solid var(--border-color)', boxShadow: '0 4px 6px rgba(0,0,0,0.02)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '15px' }}>
        <div>
          <h3 style={{ margin: 0, fontSize: '1.25rem', color: 'var(--text-main)', display: 'flex', alignItems: 'center', gap: '10px' }}>
            <span aria-hidden="true">💾</span> Supabase Database Storage
          </h3>
          <p style={{ margin: '5px 0 0 0', fontSize: '0.85rem', color: 'var(--text-muted)' }}>
            Current PostgreSQL database size reported by the server.
          </p>
        </div>
        <div style={{ textAlign: 'right' }}>
          <span style={{ fontSize: '1.4rem', fontWeight: 'bold', color: 'var(--primary)' }}>
            {Number.isFinite(dbSize) ? formatBytes(dbSize) : 'Not loaded'}
          </span>
        </div>
      </div>

      <p style={{ margin: 0, fontSize: '0.85rem', color: 'var(--text-muted)' }}>
        Storage capacity and remaining quota depend on the configured Supabase plan. Verify quota and alerts in the provider dashboard before an examination window.
      </p>
    </div>

    <div style={{ backgroundColor: '#f8fafc', border: '1px solid var(--border-color)', padding: '20px', borderRadius: '12px', display: 'flex', gap: '15px', alignItems: 'flex-start' }}>
      <span aria-hidden="true" style={{ fontSize: '1.5rem' }}>💡</span>
      <div style={{ fontSize: '0.9rem', color: 'var(--text-muted)', lineHeight: '1.5' }}>
        <strong style={{ display: 'block', fontSize: '0.95rem', color: 'var(--text-main)', marginBottom: '4px' }}>Maintain Storage Efficiency</strong>
        Production records are retained by default. Only expired attempts and reusable question-bank content have controlled maintenance actions.
      </div>
    </div>

    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: '20px' }}>
      {TABLE_METADATA.map(table => (
        <div key={table.key} style={{ backgroundColor: 'var(--panel-bg)', padding: '24px', borderRadius: '12px', border: '1px solid var(--border-color)', display: 'flex', flexDirection: 'column', justifyContent: 'space-between', boxShadow: '0 4px 6px rgba(0,0,0,0.02)' }}>
          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
              <h4 style={{ margin: 0, fontSize: '1.1rem', color: 'var(--text-main)', fontWeight: 'bold' }}>{table.name}</h4>
              <span style={{ padding: '4px 10px', borderRadius: '20px', fontSize: '0.8rem', fontWeight: 'bold', backgroundColor: 'var(--bg-color)', color: 'var(--primary)', border: '1px solid var(--border-color)' }}>
                {tableCounts[table.key] === null ? 'Not loaded' : `${tableCounts[table.key]} rows`}
              </span>
            </div>
            <p style={{ margin: '0 0 15px 0', fontSize: '0.85rem', color: 'var(--text-muted)', lineHeight: '1.4' }}>{table.desc}</p>
            <div style={{ backgroundColor: 'var(--bg-color)', border: '1px solid var(--border-color)', padding: '10px 12px', borderRadius: '6px', fontSize: '0.8rem', color: 'var(--text-muted)', marginBottom: '20px', fontWeight: '500' }}>
              ℹ️ Info: {table.warning}
            </div>
          </div>
          <button
            type="button"
            onClick={() => onMaintainTable(table.key, table.name)}
            disabled={table.protected}
            style={{
              width: '100%', padding: '10px', borderRadius: '6px', border: '1px solid var(--border-color)',
              backgroundColor: 'transparent', color: 'var(--text-main)', fontWeight: 'bold',
              cursor: table.protected ? 'not-allowed' : 'pointer', fontSize: '0.85rem', transition: 'all 0.2s',
              opacity: table.protected ? 0.55 : 1
            }}
            onMouseOver={(event) => {
              event.currentTarget.style.borderColor = 'var(--primary)';
              event.currentTarget.style.backgroundColor = 'var(--primary)';
              event.currentTarget.style.color = 'white';
            }}
            onMouseOut={(event) => {
              event.currentTarget.style.borderColor = 'var(--border-color)';
              event.currentTarget.style.backgroundColor = 'transparent';
              event.currentTarget.style.color = 'var(--text-main)';
            }}
          >
            {table.protected ? '🔒 Protected Record' : (table.actionLabel || `🧹 Maintain ${table.name}`)}
          </button>
        </div>
      ))}
    </div>
  </div>
);

export default AdminDatabaseCleanerView;
