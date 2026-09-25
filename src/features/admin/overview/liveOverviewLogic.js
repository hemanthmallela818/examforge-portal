/**
 * Parsing and display helpers for the Dashboard Overview live snapshot
 * returned by `get_admin_live_overview`.
 */

/**
 * @typedef {object} LiveExam
 * @property {string} id
 * @property {string} title
 * @property {string | null} class
 * @property {string | null} section
 * @property {string | null} activatedAt
 * @property {number | null} duration
 * @property {number | null} totalQuestions
 * @property {number} writing
 * @property {number} awaitingFinalization
 * @property {string | null} latestDeadlineAt
 * @property {number} submitted
 * @property {number} assignedStudents
 */

/**
 * @typedef {object} RecentResult
 * @property {string} id
 * @property {string} examId
 * @property {string} examTitle
 * @property {string} studentId
 * @property {string} studentName
 * @property {number | null} totalScore
 * @property {number | null} maxScore
 * @property {string | null} submittedAt
 */

/**
 * @typedef {object} LiveOverview
 * @property {string | null} checkedAt
 * @property {number} studentsWriting
 * @property {number} awaitingFinalization
 * @property {LiveExam[]} liveExams
 * @property {RecentResult[]} recentResults
 */

/** @param {unknown} value */
const count = value => {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
};

/** @param {unknown} value */
const optionalNumber = value => {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

/** @param {unknown} value */
const optionalText = value => (typeof value === 'string' && value.trim() ? value : null);

/**
 * Validates and normalizes the RPC payload.
 * @param {import('../../../types').UntrustedInput} data
 * @returns {LiveOverview}
 */
export function normalizeLiveOverview(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)
    || !Array.isArray(data.live_exams) || !Array.isArray(data.recent_results)) {
    throw new TypeError('The server returned an invalid live overview.');
  }
  /** @type {LiveExam[]} */
  const liveExams = data.live_exams
    .filter((/** @type {import('../../../types').UntrustedInput} */ row) => row && typeof row.id === 'string' && typeof row.title === 'string')
    .map((/** @type {import('../../../types').UntrustedInput} */ row) => ({
      id: row.id,
      title: row.title,
      class: optionalText(row.class),
      section: optionalText(row.section),
      activatedAt: optionalText(row.activated_at),
      duration: optionalNumber(row.duration),
      totalQuestions: optionalNumber(row.total_questions),
      writing: count(row.writing),
      awaitingFinalization: count(row.awaiting_finalization),
      latestDeadlineAt: optionalText(row.latest_deadline_at),
      submitted: count(row.submitted),
      assignedStudents: count(row.assigned_students)
    }));
  /** @type {RecentResult[]} */
  const recentResults = data.recent_results
    .filter((/** @type {import('../../../types').UntrustedInput} */ row) => row && typeof row.id === 'string' && typeof row.exam_id === 'string')
    .map((/** @type {import('../../../types').UntrustedInput} */ row) => ({
      id: row.id,
      examId: row.exam_id,
      examTitle: optionalText(row.exam_title) || 'Deleted examination',
      studentId: String(row.student_id ?? ''),
      studentName: optionalText(row.student_name) || String(row.student_id ?? 'Student'),
      totalScore: optionalNumber(row.total_score),
      maxScore: optionalNumber(row.max_score),
      submittedAt: optionalText(row.submitted_at)
    }));
  return {
    checkedAt: optionalText(data.checked_at),
    studentsWriting: count(data.students_writing),
    awaitingFinalization: count(data.awaiting_finalization),
    liveExams,
    recentResults
  };
}

/**
 * "5 min", "1 h 20 min".
 * @param {number} minutes
 */
export function formatMinutes(minutes) {
  const total = Math.max(0, Math.round(minutes));
  if (total < 60) return `${total} min`;
  const hours = Math.floor(total / 60);
  const rest = total % 60;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
}

/**
 * Local clock time ("14:05").
 * @param {string | null} iso
 */
export function formatClock(iso) {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/**
 * Human "how long ago" for recent activity ("just now", "12 min ago", "3 h ago", or a date).
 * @param {string | null} iso
 * @param {number} [now]
 */
export function formatRelativeTime(iso, now = Date.now()) {
  if (!iso) return '';
  const time = new Date(iso).getTime();
  if (Number.isNaN(time)) return '';
  const minutes = Math.floor((now - time) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return new Date(iso).toLocaleDateString();
}

/**
 * Timing lines for a live exam card.
 * @param {LiveExam} exam
 * @param {number} [now]
 * @returns {{ liveFor: string, endsBy: string }}
 */
export function describeLiveTiming(exam, now = Date.now()) {
  const activated = exam.activatedAt ? new Date(exam.activatedAt).getTime() : NaN;
  const liveFor = Number.isNaN(activated)
    ? ''
    : `Live since ${formatClock(exam.activatedAt)} (${formatMinutes((now - activated) / 60000)})`;
  const endsBy = exam.writing > 0 && exam.latestDeadlineAt
    ? `Current attempts end by ${formatClock(exam.latestDeadlineAt)}`
    : '';
  return { liveFor, endsBy };
}

/**
 * Students assigned to the exam who have neither a session nor a result yet.
 * @param {LiveExam} exam
 */
export function notStartedCount(exam) {
  return Math.max(0, exam.assignedStudents - exam.writing - exam.submitted - exam.awaitingFinalization);
}

/**
 * Score as "42 / 60"; missing values show a dash.
 * @param {number | null} score
 * @param {number | null} max
 */
export function formatScore(score, max) {
  const fmt = (/** @type {number | null} */ value) => (value === null ? '—' : Number(value).toLocaleString(undefined, { maximumFractionDigits: 2 }));
  return `${fmt(score)} / ${fmt(max)}`;
}
