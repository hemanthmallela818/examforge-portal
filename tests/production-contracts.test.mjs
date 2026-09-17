import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = async (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('exam Realtime listeners use the metadata-only published table', async () => {
  for (const path of [
    'src/components/StudentDashboard.jsx',
    'src/components/PreExam.jsx',
    'src/components/AdminDashboard.jsx'
  ]) {
    const content = await source(path);
    assert.match(content, /table:\s*['"]exam_status_events['"]/);
    assert.doesNotMatch(content, /table:\s*['"]cbt_exams_raw['"]/);
  }
});

test('creating an exam preserves question IDs for server-side grading', async () => {
  const [dashboard, paging, logic] = await Promise.all([
    source('src/components/AdminDashboard.jsx'),
    source('src/questionBankPaging.js'),
    source('src/examLogic.js')
  ]);
  assert.match(dashboard, /get_admin_questions_by_ids/);
  assert.match(paging, /id:\s*row\.id/);
  assert.match(logic, /question_id:\s*question\.id/);
});

test('question images are uploaded to private storage instead of encoded into database rows', async () => {
  const content = await source('src/components/QuestionEditor.jsx');
  assert.match(content, /storage[\s\S]*?from\(['"]exam-assets['"]\)[\s\S]*?\.upload/);
  assert.doesNotMatch(content, /canvas\.toDataURL/);
});

test('math is rendered only when the question explicitly delimits it', async () => {
  const [content, html] = await Promise.all([
    source('src/components/MathRenderer.jsx'),
    source('index.html')
  ]);
  assert.match(content, /const mathRegex =/);
  assert.match(content, /import katex from 'katex'/);
  assert.doesNotMatch(content, /\\\\\[a-zA-Z\]\+\(\?:\\\{/);
  assert.doesNotMatch(html, /cdn\.jsdelivr\.net/);
});

test('candidate-facing server errors distinguish exam rules from connectivity failures', async () => {
  const content = await source('src/App.jsx');
  assert.match(content, /function examActionErrorMessage/);
  assert.match(content, /already been submitted/);
  assert.match(content, /examActionErrorMessage\(err, 'start'\)/);
  assert.match(content, /examActionErrorMessage\(err, 'submit'\)/);
});

test('the browser bundle contains no personal developer email or browser-stored admin accounts', async () => {
  const [auth, admin] = await Promise.all([
    source('src/components/AuthPortal.jsx'),
    source('src/components/AdminDashboard.jsx')
  ]);
  assert.doesNotMatch(auth, /hemanthmallela818@gmail\.com/i);
  assert.doesNotMatch(admin, /hemanthmallela818@gmail\.com/i);
  assert.doesNotMatch(admin, /clientAdminAccounts/);
});

test('administrative access, timing, broad exam assignment, and storage rules are server-safe', async () => {
  const [app, admin, student, operationalMigration, assignmentMigration] = await Promise.all([
    source('src/App.jsx'),
    source('src/components/AdminDashboard.jsx'),
    source('src/components/StudentDashboard.jsx'),
    source('supabase/migrations/20260909060000_operational_security_fixes.sql'),
    source('supabase/migrations/20260909070000_allow_global_exam_sessions.sql')
  ]);
  assert.doesNotMatch(app, /if \(offlineSince\) return prev/);
  assert.match(admin, /supabase\.auth\.getUser/);
  assert.match(admin, /get_my_role/);
  assert.match(admin, /The exam was not created/);
  assert.match(admin, /admin_deactivate_students/);
  assert.match(student, /examObj\.class === 'All'/);
  assert.match(operationalMigration, /CREATE OR REPLACE FUNCTION public\.get_db_size/);
  assert.match(operationalMigration, /FOR SELECT TO authenticated/);
  assert.match(operationalMigration, /CREATE OR REPLACE FUNCTION public\.delete_students/);
  assert.match(assignmentMigration, /exam_row\.class = 'All'/);
});

test('account creation is server-provisioned and application tables never store passwords', async () => {
  const [edgeFunction, migration, admin] = await Promise.all([
    source('supabase/functions/manage-student/index.ts'),
    source('supabase/migrations/20260910010000_secure_account_provisioning.sql'),
    source('src/components/AdminDashboard.jsx')
  ]);
  assert.match(edgeFunction, /app_metadata:\s*\{\s*provisioned_by:\s*'admin',\s*provisioned_by_user:\s*user\.id,\s*account_type:\s*'student'/);
  assert.match(migration, /Accounts must be provisioned by an administrator/);
  assert.match(migration, /DROP COLUMN IF EXISTS password/);
  assert.doesNotMatch(admin, /\{student\.password\}/);
});

test('exam start, submit, and termination are server-owned and idempotent', async () => {
  const [startMigration, submitMigration, terminateMigration, app] = await Promise.all([
    source('supabase/migrations/20260910040000_server_owned_exam_payload.sql'),
    source('supabase/migrations/20260910030000_make_submission_idempotent.sql'),
    source('supabase/migrations/20260910020000_harden_exam_termination.sql'),
    source('src/App.jsx')
  ]);
  assert.match(startMigration, /server_exam_data/);
  assert.match(startMigration, /pg_advisory_xact_lock/);
  assert.match(submitMigration, /pg_advisory_xact_lock/);
  assert.match(submitMigration, /Invalid response payload/);
  assert.match(terminateMigration, /Exam session was not started correctly/);
  assert.match(terminateMigration, /This exam is not assigned to you/);
  assert.match(app, /submissionStartedRef/);
});

test('login and dialogs expose basic accessibility and duplicate-submit protection', async () => {
  const [auth, dialogs] = await Promise.all([
    source('src/components/AuthPortal.jsx'),
    source('src/components/CustomPopupContainer.jsx')
  ]);
  assert.match(auth, /htmlFor="login-username"/);
  assert.match(auth, /autoComplete="current-password"/);
  assert.match(auth, /disabled=\{isSubmitting\}/);
  assert.match(auth, /handleRoleTabKeyDown/);
  assert.match(auth, /tabIndex=\{role === 'STUDENT' \? 0 : -1\}/);
  assert.match(auth, /role="tabpanel"/);
  assert.match(auth, /aria-describedby=\{error \? 'login-error'/);
  assert.match(dialogs, /aria-modal="true"/);
  assert.match(dialogs, /aria-live="polite"/);
});

test('a clean installation has a server-only administrator bootstrap path', async () => {
  const bootstrap = await source('scripts/bootstrap-admin.mjs');
  assert.match(bootstrap, /SUPABASE_SERVICE_ROLE_KEY/);
  assert.match(bootstrap, /account_type:\s*'admin'/);
  assert.doesNotMatch(bootstrap, /VITE_.*SERVICE/);
});

test('offline recovery is account-bound, versioned, deadline-safe, and never replaces newer server progress', async () => {
  const [app, dashboard, logic, migration] = await Promise.all([
    source('src/App.jsx'),
    source('src/components/StudentDashboard.jsx'),
    source('src/examLogic.js'),
    source('supabase/migrations/20260910160000_stage3_integrity_corrections.sql')
  ]);
  assert.match(logic, /sessionBelongsToStudent/);
  assert.match(app, /sessionBelongsToStudent/);
  assert.match(dashboard, /sessionBelongsToStudent/);
  assert.match(app, /preserveAttempt/);
  assert.match(app, /readPendingTerminationRecord/);
  assert.match(logic, /cbt_pending_termination_v/);
  assert.match(logic, /localVersion !== authoritativeVersion/);
  assert.match(app, /setUserResponses\(syncData\.user_responses\)/);
  assert.match(app, /Date\.now\(\) >= sessionEndTimeRef\.current/);
  assert.match(migration, /clock_timestamp\(\) >= session_row\.deadline_at/);
  assert.match(migration, /expected_version_param <> session_row\.version/);
  assert.match(migration, /r\.questions_data - 'questions'/);
});

test('student takeover is bound to the signed Supabase auth session at the database boundary', async () => {
  const [auth, app, migration] = await Promise.all([
    source('src/components/AuthPortal.jsx'),
    source('src/App.jsx'),
    source('supabase/migrations/20260910170000_server_enforced_student_sessions.sql')
  ]);
  assert.match(auth, /rpc\('claim_student_session'\)/);
  assert.doesNotMatch(auth, /update\(\{\s*session_token/);
  assert.match(app, /rpc\('release_student_session'\)/);
  assert.match(app, /active_auth_session_id/);
  assert.match(app, /isStudentSessionReplaced/);
  assert.match(app, /handleSafeLogout\(\{ preserveAttempt: true \}\)/);
  assert.match(app, /Promise\.race\(\[\s*Promise\.resolve\(supabase\.rpc\('release_student_session'\)\)/);
  assert.match(migration, /auth\.jwt\(\)->>'session_id'/);
  assert.match(migration, /assert_current_student_session/);
  assert.match(migration, /REVOKE ALL ON FUNCTION public\.submit_exam_stage3_internal/);
});

test('submitted results are retained and unused exam deletion is atomic and audited', async () => {
  const [admin, migration] = await Promise.all([
    source('src/components/AdminDashboard.jsx'),
    source('supabase/migrations/20260910180000_stage5_academic_record_retention.sql')
  ]);
  assert.doesNotMatch(admin, /from\('student_results'\)\.delete/);
  assert.doesNotMatch(admin, /from\('cbt_exams'\)\.delete/);
  assert.doesNotMatch(admin, /handleFactoryReset/);
  assert.match(admin, /rpc\('admin_delete_unused_exam'/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS public\.admin_audit_events/);
  assert.match(migration, /REVOKE INSERT, UPDATE, DELETE ON public\.student_results/);
  assert.match(migration, /protect_committed_student_results/);
  assert.match(migration, /Cannot delete an exam with submitted results/);
  assert.match(migration, /INSERT INTO public\.admin_audit_events/);
  assert.match(migration, /REVOKE DELETE ON public\.cbt_exams/);
});

test('student removal is reversible and empty-class deletion is audited', async () => {
  const [auth, admin, migration] = await Promise.all([
    source('src/components/AuthPortal.jsx'),
    source('src/components/AdminDashboard.jsx'),
    source('supabase/migrations/20260910190000_stage5_student_class_retention.sql')
  ]);
  assert.match(auth, /account is inactive/i);
  assert.doesNotMatch(admin, /rpc\('delete_user'/);
  assert.doesNotMatch(admin, /rpc\('delete_students'/);
  assert.doesNotMatch(admin, /from\('classes'\)\.delete/);
  assert.match(admin, /rpc\('admin_deactivate_students'/);
  assert.match(admin, /rpc\('admin_reactivate_students'/);
  assert.match(admin, /rpc\('admin_delete_empty_class'/);
  assert.match(migration, /ADD COLUMN IF NOT EXISTS archived_at/);
  assert.match(migration, /active examination attempt and cannot be deactivated/);
  assert.match(migration, /REVOKE ALL ON FUNCTION public\.delete_user\(uuid\)/);
  assert.match(migration, /archived_at IS NULL/);
  assert.match(migration, /DEACTIVATE_STUDENT/);
  assert.match(migration, /REACTIVATE_STUDENT/);
  assert.match(migration, /DELETE_EMPTY_CLASS/);
});

test('operational cleanup finalizes expired attempts and audits question maintenance', async () => {
  const [admin, migration] = await Promise.all([
    source('src/components/AdminDashboard.jsx'),
    source('supabase/migrations/20260910200000_stage5_safe_operational_cleanup.sql')
  ]);
  assert.doesNotMatch(admin, /from\('question_bank'\)\.delete/);
  assert.doesNotMatch(admin, /from\(tableName\)\.delete/);
  assert.match(admin, /rpc\('admin_finalize_expired_sessions'/);
  assert.match(admin, /rpc\('admin_delete_question'/);
  assert.match(admin, /rpc\('admin_clear_question_bank'/);
  assert.match(migration, /REVOKE DELETE ON public\.active_sessions/);
  assert.match(migration, /submit_exam_stage3_internal/);
  assert.match(migration, /deadline_at <= clock_timestamp\(\)/);
  assert.match(migration, /FINALIZE_EXPIRED_SESSION/);
  assert.match(migration, /REVOKE DELETE ON public\.question_bank/);
  assert.match(migration, /asset_disposition.*retained_for_exam_snapshot_safety/s);
  assert.match(migration, /REVOKE UPDATE, DELETE ON public\.import_history/);
});

test('signed image URLs expire safely and imported numeric answers preserve zero', async () => {
  const [image, importerLogic, numericalPolicy] = await Promise.all([
    source('src/components/StorageImage.jsx'),
    source('src/importLogic.js'),
    source('src/numericalAnswerPolicy.js')
  ]);
  assert.match(image, /expires/);
  assert.match(image, /retryRef/);
  assert.match(importerLogic, /raw\?\.correct_answer \?\? raw\?\.correctAnswer/);
  assert.match(importerLogic, /isValidNumericalAnswer/);
  assert.match(numericalPolicy, /COMPLETE_DECIMAL\.test/);
});

test('question imports are validated centrally and committed atomically with idempotency', async () => {
  const [component, logic, migration] = await Promise.all([
    source('src/components/AIQuestionImporter.jsx'),
    source('src/importLogic.js'),
    source('supabase/migrations/20260910210000_stage6_atomic_question_import.sql')
  ]);
  assert.match(component, /rpc\('admin_import_questions'/);
  assert.doesNotMatch(component, /from\('question_bank'\)\.insert/);
  assert.doesNotMatch(component, /from\('import_history'\)\.insert/);
  assert.match(logic, /MAX_IMPORT_QUESTIONS = 500/);
  assert.match(logic, /warnings\.length === 0/);
  assert.match(migration, /CREATE UNIQUE INDEX IF NOT EXISTS question_bank_canonical_text_unique/);
  assert.match(migration, /LOCK TABLE public\.question_bank IN SHARE ROW EXCLUSIVE MODE/);
  assert.match(migration, /question_import_batches/);
  assert.match(migration, /IMPORT_QUESTIONS/);
});

test('manual authoring and exam assembly reject incomplete required media', async () => {
  const [admin, editor, logic, migration] = await Promise.all([
    source('src/components/AdminDashboard.jsx'),
    source('src/components/QuestionEditor.jsx'),
    source('src/questionContentLogic.js'),
    source('supabase/migrations/20260910220000_stage6_question_content_and_media_integrity.sql')
  ]);
  assert.match(admin, /prepareQuestionDraft\(question, selectedQData\)/);
  assert.match(admin, /has_image_or_diagram: normalizedQuestion\.hasImageOrDiagram/);
  assert.match(editor, /image\/jpeg,image\/png,image\/webp/);
  assert.match(editor, /40000000/);
  assert.match(logic, /marked as requiring an image or diagram/);
  assert.match(migration, /validate_question_bank_content_trigger/);
  assert.match(migration, /assert_exam_required_media/);
  assert.match(migration, /validate_exam_required_media_trigger/);
});

test('startup and render failures show a recoverable redacted incident screen', async () => {
  const [main, boundary, diagnostics, config, supabaseClient] = await Promise.all([
    source('src/main.jsx'),
    source('src/components/AppErrorBoundary.jsx'),
    source('src/runtimeDiagnostics.js'),
    source('src/runtimeConfig.js'),
    source('src/supabase.js')
  ]);
  assert.match(main, /import\('\.\/App\.jsx'\)/);
  assert.match(main, /<AppErrorBoundary>/);
  assert.match(main, /<StartupFailure error=\{error\}/);
  assert.match(boundary, /Your saved exam progress has not been cleared/);
  assert.match(boundary, /window\.location\.reload/);
  assert.match(diagnostics, /REDACTED_TOKEN/);
  assert.match(diagnostics, /unhandledrejection/);
  assert.doesNotMatch(diagnostics, /error\?\.stack/);
  assert.match(config, /must use HTTPS outside local development/);
  assert.match(supabaseClient, /detectSessionInUrl: false/);
});

test('administrators have an AAL2-only read-only health and audit view', async () => {
  const [admin, operationsView, migration] = await Promise.all([
    source('src/components/AdminDashboard.jsx'),
    source('src/components/AdminOperationsView.jsx'),
    source('supabase/migrations/20260910230000_stage7_operational_health.sql')
  ]);
  assert.match(admin, /rpc\('admin_operational_health'\)/);
  assert.match(admin, /from\('admin_audit_events'\)/);
  assert.match(admin, /Operations & Audit/);
  assert.match(operationsView, /latest 100 retained server audit events/i);
  assert.match(migration, /IF NOT public\.is_admin_aal2\(\)/);
  assert.match(migration, /expired_sessions_pending_finalization/);
  assert.match(migration, /questions_missing_required_media/);
  assert.doesNotMatch(migration, /user_responses|student_name|student_id'/);
});

test('material administrator mutations create server audit events without per-row bulk-import noise', async () => {
  const [edge, importMigration, auditMigration] = await Promise.all([
    source('supabase/functions/manage-student/index.ts'),
    source('supabase/migrations/20260910210000_stage6_atomic_question_import.sql'),
    source('supabase/migrations/20260910240000_stage7_admin_action_audit.sql')
  ]);
  assert.match(edge, /caller\.rpc\('admin_update_student_assignment'/);
  assert.match(edge, /provisioned_by_user: user\.id/);
  assert.match(importMigration, /set_config\('cbt\.question_import_batch', 'on', true\)/);
  assert.match(auditMigration, /CREATE_EXAM/);
  assert.match(auditMigration, /CHANGE_EXAM_STATUS/);
  assert.match(auditMigration, /CREATE_QUESTION/);
  assert.match(auditMigration, /CREATE_CLASS/);
  assert.match(auditMigration, /UPDATE_STUDENT_ASSIGNMENT/);
  assert.match(auditMigration, /PROVISION_STUDENT/);
  assert.doesNotMatch(auditMigration, /user_responses|correct_answer|questions_data'\s*,/);
});

test('exam overlays and question status controls expose semantic accessibility state', async () => {
  const [app, modal, focus, offline, grid] = await Promise.all([
    source('src/App.jsx'),
    source('src/components/AccessibleModal.jsx'),
    source('src/dialogFocus.js'),
    source('src/components/OfflineOverlay.jsx'),
    source('src/components/GridPanel.jsx')
  ]);
  assert.match(app, /labelledBy="security-warning-title"/);
  assert.match(app, /labelledBy="submit-exam-title"/);
  assert.match(modal, /aria-modal="true"/);
  assert.match(focus, /querySelectorAll\(FOCUSABLE_SELECTOR\)/);
  assert.match(focus, /returnTarget\.focus\(\)/);
  assert.match(focus, /capturedReturnFocusRef/);
  assert.match(offline, /aria-labelledby="offline-overlay-title"/);
  assert.match(offline, /useDialogFocusTrap/);
  assert.match(grid, /aria-current=\{isActive/);
  assert.match(grid, /getStatusLabel/);
});

test('large collections are complete, bounded, deferred, and refreshed without event storms', async () => {
  const [admin, student, pagination, indexes, examPaging] = await Promise.all([
    source('src/components/AdminDashboard.jsx'),
    source('src/components/StudentDashboard.jsx'),
    source('src/paginatedQuery.js'),
    source('supabase/migrations/20260910250000_stage8_scale_indexes.sql'),
    source('supabase/migrations/20260910310000_stage19_paginated_exam_list.sql')
  ]);
  assert.match(admin, /fetchAllRows/);
  assert.match(student, /fetchAllRows/);
  assert.match(admin, /Large collections\s*\n\s*\/\/ are loaded when their owning screen is opened/);
  assert.match(admin, /scheduleCollectionRefresh/);
  assert.match(admin, /get_admin_exam_list_page/);
  assert.match(examPaging, /'duration', exam\.questions_data->>'duration'/);
  assert.doesNotMatch(examPaging, /'questions_data', exam\.questions_data/);
  assert.match(pagination, /CollectionLimitError/);
  assert.match(pagination, /pageSize > 1000/);
  assert.match(indexes, /active_sessions_deadline_idx/);
  assert.match(indexes, /admin_audit_events_occurred_idx/);
});

test('authenticated dashboards retain usable mobile layouts and announce load failures', async () => {
  const [admin, student, css] = await Promise.all([
    source('src/components/AdminDashboard.jsx'),
    source('src/components/StudentDashboard.jsx'),
    source('src/index.css')
  ]);
  assert.match(admin, /className="admin-dashboard-shell"/);
  assert.match(admin, /aria-label="Administrator sections"/);
  assert.match(admin, /minmax\(min\(100%, 350px\), 1fr\)/);
  assert.match(student, /className="student-exam-card"/);
  assert.match(student, /className="student-recovery-banner" role="status"/);
  assert.match(student, /<div role="alert" style=\{\{ padding: '12px'/);
  assert.match(css, /@media \(max-width: 900px\)/);
  assert.match(css, /\.admin-dashboard-shell[\s\S]*flex-direction: column !important/);
  assert.match(css, /\.student-exam-card[\s\S]*flex-direction: column !important/);
});

test('the active exam remains usable on narrow screens with announced save and network state', async () => {
  const [app, navbar, question, grid, css] = await Promise.all([
    source('src/App.jsx'),
    source('src/components/ExamNavbar.jsx'),
    source('src/components/QuestionPanel.jsx'),
    source('src/components/GridPanel.jsx'),
    source('src/index.css')
  ]);
  assert.match(app, /className="active-exam-content"/);
  assert.match(navbar, /className="exam-navbar-indicators"/);
  assert.match(navbar, /role="timer"/);
  assert.match(navbar, /aria-live="polite"/);
  assert.match(question, /className="exam-question-panel"/);
  assert.match(question, /className="exam-navigation-actions"/);
  assert.match(grid, /<aside className="exam-grid-panel" aria-label="Question navigator"/);
  assert.match(css, /\.active-exam-content[\s\S]*flex-direction: column !important/);
  assert.match(css, /\.exam-grid-panel[\s\S]*width: 100% !important/);
});

test('instructions and termination accurately describe server-confirmed grading', async () => {
  const [preExam, terminated, result, css] = await Promise.all([
    source('src/components/PreExam.jsx'),
    source('src/components/Terminated.jsx'),
    source('src/components/Result.jsx'),
    source('src/index.css')
  ]);
  assert.match(preExam, /last server-confirmed answers/);
  assert.doesNotMatch(preExam, /award 0 marks/);
  assert.match(terminated, /will be finalized using the answers confirmed by the server before termination/);
  assert.doesNotMatch(terminated, /awarded 0 marks/);
  assert.match(terminated, /role="alert"/);
  assert.match(result, /className="result-stats"/);
  assert.match(css, /\.result-stats[\s\S]*grid-template-columns: 1fr !important/);
});
