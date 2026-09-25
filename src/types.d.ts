/**
 * Shared domain types for the pure logic modules (src/*.js).
 *
 * Type-only: this file is never bundled. Logic modules reference it through
 * JSDoc, e.g. `/** @import { ExamResponses } from './types' *\/`, and
 * `npm run typecheck` (tsconfig.json, checkJs + strict) verifies them.
 */

// ---------------------------------------------------------------------------
// Generic helpers
// ---------------------------------------------------------------------------

/**
 * A value parsed from JSON, browser storage, or a server/RPC payload that has
 * NOT been validated yet. Deliberately `any` so the validation code that
 * follows can probe it; every function receiving one must validate before
 * returning a typed value. Grep for this alias to find trust boundaries.
 */
export type UntrustedInput = any;

/** The subset of the Web Storage API the logic modules use. */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export type StorageAreaName = 'localStorage' | 'sessionStorage';

// ---------------------------------------------------------------------------
// Exam session / responses (examLogic.js)
// ---------------------------------------------------------------------------

export type ResponseStatus = 'NOT_VISITED' | 'NOT_ANSWERED' | 'ANSWERED' | 'MARKED' | 'ANSWERED_MARKED';

/** MCQ answers are option indices; numerical answers are decimal strings. */
export type SelectedOption = number | string | null;

/** One candidate response to one question. */
export interface QuestionResponse {
  selectedOption: SelectedOption;
  status: ResponseStatus;
}

/** Responses for one subject, in question order. */
export type SubjectResponse = QuestionResponse[];

/** Responses keyed by subject name. */
export type ExamResponses = Record<string, SubjectResponse>;

/**
 * Responses from an untrusted source (browser storage, older client builds):
 * entries may be missing or have unknown statuses.
 */
export interface LooseQuestionResponse {
  selectedOption?: SelectedOption;
  status?: string;
}
export type LooseExamResponses = Record<string, Array<LooseQuestionResponse | null | undefined> | undefined>;

/** Per-subject index of the question currently shown. */
export type CurrentIndices = Record<string, number>;

/** Minimal student identity used for storage ownership checks. */
export interface StudentIdentity {
  id?: string | number | null;
  docId?: string | null;
}

/** A question as delivered inside a server-owned exam paper. */
export interface ExamQuestion {
  id: string;
  type?: string;
  text?: string;
  options?: string[] | null;
  questionImageUrl?: string | null;
  optionImageUrls?: Array<string | null> | null;
  hasImageOrDiagram?: boolean;
}

/** The question paper: ordered subjects and their questions. */
export interface ExamPaper {
  subjects?: string[];
  questions?: Record<string, Array<ExamQuestion | null | undefined> | undefined>;
  duration?: number;
  marksCorrect?: number;
  marksIncorrect?: number;
}

/** Row shape sent to the submit RPC. */
export interface SubmissionResponse {
  question_id: string;
  selected_option: SelectedOption;
  status: ResponseStatus;
}

export interface PendingSubmissionRecord {
  schemaVersion: number;
  examId: string;
  studentId: string;
  userUuid: string;
  responses: SubmissionResponse[];
  timestamp: number;
}

export interface PendingTerminationRecord {
  schemaVersion: number;
  examId: string;
  studentId: string;
  userUuid: string;
  timestamp: number;
}

/** Common arguments for the storage-scoped record helpers. */
export interface StudentExamScope {
  student?: StudentIdentity | null;
  examId?: string | null;
  userUuid?: string | null;
  storage?: StorageLike | null;
}

/** Versioned, ownership-stamped offline snapshot of an in-progress attempt. */
export interface OfflineRecoveryRecord {
  schemaVersion: number;
  userUuid: string;
  studentId: string;
  examId: string;
  sessionId: string;
  savedAt: number;
  version: number;
  endTime: number;
  activeSubject: string;
  currentIndices: CurrentIndices;
  userResponses: ExamResponses | LooseExamResponses;
}

/** Backwards-compatible mirror kept under `cbt_active_exam_session`. */
export interface ActiveExamSessionMirror {
  schemaVersion: number;
  examId: string;
  userUuid: string;
  studentId: string;
  activeExam: { id: string; title?: string };
  examData?: ExamPaper;
  userResponses?: ExamResponses | LooseExamResponses;
  activeSubject?: string;
  currentIndices?: CurrentIndices;
  endTime?: number;
  savedAt: number;
  version: number;
}

export interface SaveOfflineRecoveryInput {
  student?: StudentIdentity | null;
  examId?: string | null;
  examTitle?: unknown;
  userUuid?: string | null;
  examData?: ExamPaper;
  userResponses?: ExamResponses | LooseExamResponses;
  activeSubject?: string;
  currentIndices?: CurrentIndices;
  version?: number;
  endTime?: number;
  /** Defaults to the browser's localStorage. */
  storage?: StorageLike | null;
}

/** `{ success, error }` result used by storage writers. */
export type StorageWriteResult<Extra = object> =
  | ({ success: true; error: null } & Extra)
  | { success: false; error: unknown };

export interface ReconcileInput {
  examData?: ExamPaper | null;
  serverResponses?: ExamResponses | LooseExamResponses | null;
  serverVersion?: unknown;
  localRecord?: { version?: unknown; userResponses?: LooseExamResponses } | null;
}

export interface ReconcileResult {
  responses: ExamResponses | LooseExamResponses;
  conflict: boolean;
  usedLocal: boolean;
  localVersion?: number | null;
  serverVersion?: number | null;
}

/** Error shape returned by Supabase/PostgREST RPC calls. */
export interface RpcErrorLike {
  message?: unknown;
  code?: unknown;
  status?: unknown;
  httpStatus?: unknown;
}

// ---------------------------------------------------------------------------
// Question import (importLogic.js, questionContentLogic.js)
// ---------------------------------------------------------------------------

export type ImportQuestionType = 'MCQ' | 'NUMERICAL';

export interface ImportOptions {
  /** Administrator-configured subjects; falls back to ALLOWED_IMPORT_SUBJECTS. */
  allowedSubjects?: unknown;
  /** Reject fields outside the reviewed JSON schema (file imports). */
  strictSource?: boolean;
  /** Force every row to start unapproved. */
  requireExplicitApproval?: boolean;
}

/** A question row after normalisation, before validation. */
export interface ImportQuestion {
  id: string;
  sourceId: string;
  rowNumber: number;
  text: string;
  /** Upper-cased source type; only 'MCQ' | 'NUMERICAL' pass validation. */
  type: string;
  options: string[];
  /** MCQ: '0'..'3' after normalisation; NUMERICAL: decimal text. */
  correctAnswer: string;
  subject: string;
  hasImageOrDiagram: boolean;
  schemaWarnings: string[];
  approved: boolean | undefined;
}

export interface ImportRowError {
  code: string;
  field: string;
  message: string;
}

export interface ValidatedImportQuestion extends Omit<ImportQuestion, 'approved'> {
  warnings: string[];
  rowErrors: ImportRowError[];
  approved: boolean;
  status: 'VALID' | 'WARNING';
}

/** Existing Question Bank entry used for duplicate detection. */
export interface QuestionTextLike {
  id?: string;
  docId?: string;
  text?: string | null;
  question_text?: string | null;
}

export interface ImportFileLike {
  name: string;
  size: number;
  type?: string;
}

export type ImportFileValidation =
  | { valid: true; fileName: string }
  | { valid: false; error: string };

/** Row inserted by the atomic import RPC. */
export interface AtomicImportRow {
  subject: string;
  type: string;
  question_text: string;
  options: string[];
  correct_answer: string;
  has_image_or_diagram: boolean;
  category: 'Mains';
  points: number;
  neg_points: number;
}

/** Normalised question produced by the Question Editor. */
export interface PreparedQuestion {
  [field: string]: unknown;
  subject: string;
  type: string;
  text: string;
  options: string[];
  correctAnswer: string;
  questionImageUrl: string | null;
  optionImageUrls: unknown[];
  hasImageOrDiagram: boolean;
}

// ---------------------------------------------------------------------------
// Exam patterns (examPatternLogic.js)
// ---------------------------------------------------------------------------

export interface PatternSection {
  subject: string;
  /** Form inputs hold strings; stored templates hold numbers. */
  questionCount: number | string;
}

export interface PatternTemplate {
  id?: string;
  name?: string;
  description?: string;
  durationMinutes?: number | string;
  marksCorrect?: number | string;
  marksIncorrect?: number | string;
  sections: PatternSection[];
}

export interface PatternDraft {
  name: string;
  description: string;
  durationMinutes: number | string;
  marksCorrect: number | string;
  marksIncorrect: number | string;
  sections: PatternSection[];
}

export interface SubjectConfig {
  name: string;
  isActive: boolean;
}

export interface PatternSelectionRow {
  subject: string;
  required: number;
  selected: number;
  status: 'ok' | 'short' | 'over';
}

export interface PatternSelectionResult {
  ok: boolean;
  rows: PatternSelectionRow[];
  extras: Array<{ subject: string; selected: number }>;
  problems: string[];
}

// ---------------------------------------------------------------------------
// Exam preflight (examPreflightLogic.js)
// ---------------------------------------------------------------------------

export type LatexCheck = { balanced: true } | { balanced: false; reason: string };

export interface PreflightResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
  stats: {
    totalQuestions: number;
    subjectCounts: Record<string, number>;
    storageAssetCount: number;
    externalAssetCount: number;
  };
  storageAssets: string[];
}

// ---------------------------------------------------------------------------
// Paging / server payloads
// ---------------------------------------------------------------------------

export interface PageExpectation {
  expectedPage: number;
  expectedPageSize: number;
}

export interface PagedCollection<Row = UntrustedInput> {
  page: number;
  pageSize: number;
  total: number;
  rows: Row[];
}

/** Supabase range query result consumed by fetchAllRows. */
export interface RangeQueryResult<Row> {
  data: Row[] | null;
  error: unknown;
}

export interface QuestionBankItem {
  docId: string;
  id: string;
  subject: string;
  type: 'MCQ' | 'NUMERICAL';
  questionNumber: number;
  text: string;
  options: string[] | null;
  correctAnswer: string | null;
  questionImageUrl: string | null;
  optionImageUrls: Array<string | null> | null;
  hasImageOrDiagram: boolean;
  createdAt: string;
}

export interface ExamListItem {
  id: string;
  title: string;
  status: string;
  class: string;
  section: string;
  created_at: string;
  questionsData: { duration: number; totalQuestions: number; subjects: string[] };
}

// ---------------------------------------------------------------------------
// Results (resultPaging.js, resultExportLogic.js)
// ---------------------------------------------------------------------------

/** A student's result before ranking (client or server supplied). */
export interface ResultInput {
  [field: string]: unknown;
  studentId?: unknown;
  studentName?: unknown;
  totalScore?: unknown;
  maxScore?: unknown;
  subjectScores?: Record<string, unknown> | null;
}

export interface LeaderboardRow {
  [field: string]: unknown;
  studentId: string;
  studentName: string;
  totalScore: number;
  maxScore: number;
  subjectScores: Record<string, number>;
  totalRank: number;
  subjectRanks: Record<string, number>;
}

export interface ResultAnalytics {
  averageScore: number;
  highestScore: number;
  lowestScore: number;
  distribution: Array<{ name: string; count: number }>;
  excludedFromDistribution: number;
  subjectAverages: Array<{ name: string; score: number }>;
}

export type PdfExportValidation =
  | { ok: false; error: string }
  | { ok: true; results: LeaderboardRow[]; subjects: string[] };

/** The subset of the jsPDF API used for the leaderboard export. */
export interface PdfDocumentLike {
  setFontSize(size: number): unknown;
  setTextColor(r: number, g: number, b: number): unknown;
  splitTextToSize(text: string, maxWidth: number): string[];
  text(text: string | string[], x: number, y: number, options?: Record<string, unknown>): unknown;
  getNumberOfPages(): number;
  save(filename: string): unknown;
  internal: { pageSize: { getWidth(): number; getHeight(): number } };
}

export type PdfConstructorLike = new (orientation: string, unit: string, format: string) => PdfDocumentLike;
export type AutoTableLike = (doc: PdfDocumentLike, options: Record<string, unknown>) => unknown;

export interface RankedResultRow {
  [field: string]: unknown;
  id?: unknown;
  examId: unknown;
  studentId: string;
  studentName: string;
  totalScore: number;
  maxScore: number;
  subjectScores: Record<string, unknown>;
  subjectRanks: Record<string, unknown>;
  totalRank: number;
}

export interface ExportResultRow {
  [field: string]: unknown;
  id: unknown;
  examId: unknown;
  studentId: string;
  studentName: string;
  totalScore: number;
  maxScore: number;
  subjectScores: Record<string, unknown>;
}

export interface ResultPage extends PagedCollection<RankedResultRow> {
  resultCount: number;
  subjects: string[];
  analytics: (Omit<ResultAnalytics, 'distribution' | 'subjectAverages'> & {
    distribution: Array<{ name: string; count: unknown }>;
    subjectAverages: Array<{ name: string; score: unknown }>;
  }) | null;
}

export interface ResultExportPage {
  resultCount: number;
  subjects: string[];
  rows: ExportResultRow[];
  hasMore: boolean;
  nextCursor: string | null;
}

// ---------------------------------------------------------------------------
// Images, runtime, diagnostics
// ---------------------------------------------------------------------------

/** File/Blob fields read by the image validators. */
export interface ImageFileLike {
  name?: string;
  type: string;
  size: number;
  slice(start?: number, end?: number): Blob;
}

export interface ImageValidationResult {
  valid: boolean;
  error?: string;
  format?: string;
  dimensions?: { width: number; height: number };
}

export interface NumericalValidation {
  valid: boolean;
  empty: boolean;
  transient: boolean;
  text: string;
  error: string;
}

/** Browser globals probed by checkBrowserCompatibility (injectable for tests). */
export interface BrowserEnvironment {
  crypto?: { randomUUID?: unknown } | null;
  localStorage?: Partial<StorageLike> | null;
  sessionStorage?: Partial<StorageLike> | null;
  fetch?: unknown;
  Promise?: { allSettled?: unknown } | null;
  Intl?: unknown;
}

export interface ClientErrorDetails {
  context: string;
  name: string;
  message: string;
  code: string;
  status: number | undefined;
}

/** Result of `supabase.functions.invoke`. */
export interface FunctionInvocationResult {
  data?: UntrustedInput;
  error?: { message?: unknown; context?: UntrustedInput } | null;
}

// ---------------------------------------------------------------------------
// UI events (utils.js, CustomPopupContainer.jsx)
// ---------------------------------------------------------------------------

export type ToastType = 'info' | 'success' | 'error' | 'warning';

/** `detail` of the `app-toast` window event. */
export interface ToastEventDetail {
  message: string;
  type: ToastType;
}

export type DialogType = 'alert' | 'confirm' | 'prompt';

/** `detail` of the cancelable `show-dialog` window event. */
export interface DialogEventDetail {
  type: DialogType;
  message: string;
  defaultValue?: string;
  onResolve: (value: UntrustedInput) => void;
}

// ---------------------------------------------------------------------------
// Administrator workspace (src/features/admin/**)
// ---------------------------------------------------------------------------

export interface DataLoadEntry {
  loading: boolean;
  error: string;
}

/** Per-collection loading/error state keyed by load key ('classes', 'counts', ...). */
export type DataLoadState = Record<string, DataLoadEntry | undefined>;

export type AdminLoadResult<T> =
  | { ok: true; current: boolean; data: T; error?: undefined }
  | { ok: false; current: boolean; error: unknown; data?: undefined };

export type RunAdminDataLoad = <T>(
  key: string,
  failureMessage: string,
  work: () => Promise<T>
) => Promise<AdminLoadResult<T>>;

/** `public.classes` row. */
export interface ClassRow {
  id: string;
  name: string;
  sections: string[] | null;
  created_at?: string;
}

/** Row of `admin_list_subjects`. */
export interface SubjectCatalogEntry {
  id: string;
  name: string;
  displayOrder: number;
  isActive: boolean;
  usage?: { questions?: number; templates?: number; [key: string]: number | undefined } | null;
}

/** Row of `admin_list_exam_templates`. */
export interface ExamTemplateEntry {
  id: string;
  name: string;
  description: string | null;
  durationMinutes: number;
  marksCorrect: number;
  marksIncorrect: number;
  sections: PatternSection[];
  isActive: boolean;
  totalQuestions: number;
  inactiveSubjects: string[] | null;
  updatedAt?: string;
}

export interface TableCounts {
  question_bank: number | null;
  cbt_exams: number | null;
  student_results: number | null;
  active_sessions: number | null;
  students: number | null;
  classes: number | null;
  import_history: number | null;
}

/** Request shown by the shared DestructiveActionDialog. */
export interface DestructiveActionRequest {
  title: string;
  description?: string;
  impact?: Array<{ label: string; count: number | null | undefined }>;
  preserved?: string[];
  /** Exact phrase the operator must type. */
  phrase: string;
  confirmLabel: string;
  /** Performs the action; resolves to the success message. */
  run: (confirmation: string) => Promise<string | void | undefined>;
}
