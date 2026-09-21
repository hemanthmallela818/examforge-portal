import { createClient } from '@supabase/supabase-js';

const url = process.env.REHEARSAL_SUPABASE_URL;
const anonKey = process.env.REHEARSAL_SUPABASE_ANON_KEY;
const serviceKey = process.env.REHEARSAL_SUPABASE_SERVICE_ROLE_KEY;
const adminAccessToken = process.env.REHEARSAL_ADMIN_AAL2_ACCESS_TOKEN;
const expectedProjectRef = process.env.REHEARSAL_EXPECTED_PROJECT_REF;
const destructiveConfirmation = process.env.REHEARSAL_CONFIRM_DISPOSABLE;
const candidateCount = Number.parseInt(process.env.REHEARSAL_CANDIDATE_COUNT || '80', 10);

if (!url || !anonKey || !serviceKey || !adminAccessToken || !expectedProjectRef) {
  throw new Error('Rehearsal URL, anon key, service-role key, AAL2 admin access token, and expected project ref are required.');
}
const rehearsalHost = new URL(url).hostname;
const localTarget = rehearsalHost === '127.0.0.1' || rehearsalHost === 'localhost';
if (localTarget ? expectedProjectRef !== 'local' : rehearsalHost !== `${expectedProjectRef}.supabase.co`) {
  throw new Error(`Refusing to run: target host does not match REHEARSAL_EXPECTED_PROJECT_REF (${expectedProjectRef}).`);
}
if (destructiveConfirmation !== 'YES_RESET_THIS_DISPOSABLE_PROJECT_AFTER_REHEARSAL') {
  throw new Error('Refusing to run without explicit disposable-project reset confirmation.');
}
if (!Number.isInteger(candidateCount) || candidateCount < 1 || candidateCount > 1000) {
  throw new Error('REHEARSAL_CANDIDATE_COUNT must be an integer from 1 through 1000.');
}

const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
const prefix = `REHEARSAL-${Date.now()}`;
const className = `${prefix}-CLASS`;
const studentPassword = 'Rehearsal!12345';
const students = Array.from({ length: candidateCount }, (_, index) => ({
  studentId: `${prefix}-S${String(index + 1).padStart(3, '0')}`,
  email: `${prefix.toLowerCase()}-s${String(index + 1).padStart(3, '0')}@rehearsal.local`,
  name: `Rehearsal Student ${index + 1}`
}));

// Keep one distinct scoring fingerprint per candidate in larger load runs.
const questionCount = Math.max(80, candidateCount);
const subjects = ['Physics', 'Chemistry', 'Mathematics'];
const rehearsalQuestions = Object.fromEntries(subjects.map(subject => [subject, []]));
for (let index = 0; index < questionCount; index += 1) {
  const subject = subjects[index % subjects.length];
  rehearsalQuestions[subject].push({
    id: `${prefix}-q-${String(index + 1).padStart(3, '0')}`,
    subject,
    type: 'NUMERICAL',
    text: `Rehearsal numerical question ${index + 1}`,
    options: [],
    correctAnswer: String(index + 1),
    hasImageOrDiagram: false
  });
}

const questionsData = {
  subjects,
  duration: 30,
  marksCorrect: 4,
  marksIncorrect: -1,
  questions: rehearsalQuestions
};

const responsesForCandidate = correctTarget => {
  const grouped = Object.fromEntries(subjects.map(subject => [subject, []]));
  const flattened = [];
  for (let index = 0; index < questionCount; index += 1) {
    const subject = subjects[index % subjects.length];
    const questionId = `${prefix}-q-${String(index + 1).padStart(3, '0')}`;
    const selectedOption = index < correctTarget ? String(index + 1) : String(-(index + 1));
    grouped[subject].push({ selectedOption, status: 'ANSWERED' });
    flattened.push({ question_id: questionId, selected_option: selectedOption, status: 'ANSWERED' });
  }
  return { grouped, flattened };
};

const limit = async (items, concurrency, task) => {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await task(items[index], index);
    }
  }));
  return results;
};

const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

// Supabase Auth rate-limits password sign-ins by source IP. Keep the
// rehearsal's sign-in starts globally paced even though the rest of the
// candidate workload can remain concurrent. The staging rate-limit setting
// and this delay should be chosen together (for example, 120 sign-ins/5 min
// with a 3000 ms delay). The value is configurable so production-like
// staging environments do not require a code change.
const authSignInDelayMs = Number.parseInt(process.env.REHEARSAL_AUTH_SIGNIN_DELAY_MS || '3000', 10);
if (!Number.isInteger(authSignInDelayMs) || authSignInDelayMs < 0) {
  throw new Error('REHEARSAL_AUTH_SIGNIN_DELAY_MS must be a non-negative integer.');
}
let nextAuthSignInAt = 0;
let authSignInQueue = Promise.resolve();
const waitForAuthSignInSlot = async () => {
  let release;
  const previous = authSignInQueue;
  authSignInQueue = new Promise(resolve => { release = resolve; });
  await previous;
  const remaining = nextAuthSignInAt - Date.now();
  if (remaining > 0) await wait(remaining);
  nextAuthSignInAt = Date.now() + authSignInDelayMs;
  release();
};

const withRetries = async (task, attempts = 5) => {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await task();
    } catch (error) {
      lastError = error;
      if (error?.status !== 429 || attempt === attempts - 1) throw error;
      // A 429 is an IP bucket response, so short retries only extend the
      // burst. Back off exponentially and keep the next attempt behind the
      // normal sign-in pacing window.
      await wait(Math.max(authSignInDelayMs, 5000 * (2 ** attempt)));
    }
  }
  throw lastError;
};

const functionErrorSummary = async error => {
  const status = Number(error?.context?.status) || 0;
  let body = '';
  try {
    body = await error?.context?.clone?.().text?.() || '';
  } catch {}
  const boundedBody = body.replace(/[\r\n]+/g, ' ').slice(0, 500);
  return `HTTP ${status || 'unknown'}${boundedBody ? `: ${boundedBody}` : ''}`;
};

const subscribe = (client, channelName) => new Promise(resolve => {
  const channel = client.channel(channelName);
  const timeout = setTimeout(() => resolve({ channel, status: 'TIMED_OUT' }), 15_000);
  channel.subscribe(status => {
    if (status === 'SUBSCRIBED' || status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
      clearTimeout(timeout);
      resolve({ channel, status });
    }
  });
});

let examId;
let authIds = [];
const channels = [];
const startedAt = Date.now();
const latencyMs = { start: [], autosave: [], submit: [], retry: [], realtime: [] };
const timed = async (bucket, task) => {
  const began = performance.now();
  try { return await task(); } finally { bucket.push(performance.now() - began); }
};
const percentile = (values, percent) => {
  if (!values.length) return 0;
  const ordered = [...values].sort((a, b) => a - b);
  return Number(ordered[Math.ceil((percent / 100) * ordered.length) - 1].toFixed(1));
};
const report = {
  candidateCount: students.length,
  questionCount,
  createdStudents: 0,
  authenticatedStudents: 0,
  sessionClaims: 0,
  realtimeSubscribed: 0,
  startedSessions: 0,
  autosavedSessions: 0,
  submittedResults: 0,
  idempotentSubmissionRetries: 0,
  unauthorizedWriteBlocked: false,
  unauthorizedExamWriteBlocked: false,
  studentProvisioningBlocked: false,
  crossAccountSessionsHidden: false,
  crossAccountResultsHidden: false,
  zeroLostOrCrossAccountAnswers: false,
  zeroDuplicateResults: false,
  zeroUnhandledServerErrors: false,
  adminProvisionedStudent: false,
  answersHidden: false,
  cleanupCompleted: false,
  stagingResetRequired: true
};

try {
  const { error: classError } = await admin.from('classes').insert({ name: className, sections: ['A'] });
  if (classError) throw classError;

  const created = await limit(students, 4, async student => {
    const { data, error } = await admin.auth.admin.createUser({
      email: student.email,
      password: studentPassword,
      email_confirm: true,
      user_metadata: { student_id: student.studentId, name: student.name, class: className, section: 'A' },
      app_metadata: { provisioned_by: 'admin', account_type: 'student' }
    });
    if (error) throw error;
    const createdStudent = { ...student, authId: data.user.id };
    authIds.push(createdStudent.authId);
    const { error: finalizeError } = await admin.rpc('complete_account_provisioning', {
      account_id_param: createdStudent.authId
    });
    if (finalizeError) {
      await admin.auth.admin.deleteUser(createdStudent.authId);
      throw finalizeError;
    }
    return createdStudent;
  });
  report.createdStudents = created.length;

  const { data: exam, error: examError } = await admin.from('cbt_exams').insert({
    title: `${prefix} Exam`, status: 'ACTIVE', class: className, section: 'A', questions_data: questionsData
  }).select().single();
  if (examError) throw examError;
  examId = exam.id;

  // Stagger sign-ins so this rehearsal also respects Supabase's anti-abuse
  // limits when all test accounts originate from one IP address. The global
  // slot gate is required even though the surrounding worker pool is small.
  const authenticated = await limit(created, 4, async student => {
    const client = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
    const authData = await withRetries(async () => {
      await waitForAuthSignInSlot();
      const result = await client.auth.signInWithPassword({ email: student.email, password: studentPassword });
      if (result.error) throw result.error;
      return result.data;
    });
    if (!authData?.user) throw new Error('Student sign-in did not return a user.');

    const { data: claim, error: claimError } = await client.rpc('claim_student_session');
    if (claimError || !claim?.session_id) throw claimError || new Error('Student session claim did not return a signed session ID.');
    return { student, client };
  });
  report.authenticatedStudents = authenticated.length;
  report.sessionClaims = authenticated.length;

  // Exercise concurrent starts and autosaves separately from rate-limited sign-in.
  const sessions = await limit(authenticated, 16, async ({ student, client }, candidateIndex) => {
    const { data: visibleExam, error: visibleExamError } = await client.from('cbt_exams').select('*').eq('id', examId).single();
    if (visibleExamError) throw visibleExamError;
    const visibleText = JSON.stringify(visibleExam.questions_data);
    if (visibleText.includes('correctAnswer') || visibleText.includes('correct_answer')) {
      throw new Error('Answer key was exposed to a student.');
    }

    const correctTarget = candidateIndex + 1;
    const candidateResponses = responsesForCandidate(correctTarget);
    const { data: session, error: sessionError } = await timed(latencyMs.start, () => client.rpc('start_exam_session', {
      exam_id_param: examId,
      exam_data_param: visibleExam.questions_data,
      responses_param: candidateResponses.grouped
    }));
    if (sessionError) throw sessionError;
    const { error: autosaveError } = await timed(latencyMs.autosave, () => client.rpc('sync_active_session_progress', {
      exam_id_param: examId,
      responses_param: session.user_responses,
      expected_version_param: session.version
    }));
    if (autosaveError) throw autosaveError;
    return { student, client, session, correctTarget, submissionResponses: candidateResponses.flattened };
  });
  report.startedSessions = sessions.length;
  report.autosavedSessions = sessions.length;
  report.answersHidden = true;

  const subscriptionResults = await Promise.all(sessions.map(({ client }, index) =>
    timed(latencyMs.realtime, () => subscribe(client, `${prefix}-channel-${index}`))));
  subscriptionResults.forEach(result => channels.push(result.channel));
  report.realtimeSubscribed = subscriptionResults.filter(result => result.status === 'SUBSCRIBED').length;
  if (report.realtimeSubscribed !== students.length) throw new Error(`Only ${report.realtimeSubscribed}/${students.length} Realtime channels subscribed.`);

  const firstClient = sessions[0].client;
  const { data: foreignSessions, error: foreignSessionsError } = await firstClient
    .from('active_sessions')
    .select('student_id')
    .neq('student_id', sessions[0].student.studentId);
  report.crossAccountSessionsHidden = Boolean(foreignSessionsError) || (foreignSessions || []).length === 0;
  if (!report.crossAccountSessionsHidden) throw new Error('A student could read another candidate\'s active session.');

  const { error: forgedWriteError } = await firstClient.from('student_results').insert({
    exam_id: examId, student_id: 'forged', total_score: 9999, max_score: 9999
  });
  report.unauthorizedWriteBlocked = Boolean(forgedWriteError);
  if (!report.unauthorizedWriteBlocked) throw new Error('A student was able to forge a result row.');

  const { error: forgedExamError } = await firstClient.from('cbt_exams').insert({
    title: `${prefix} Forged Exam`, status: 'ACTIVE', class: className, section: 'A', questions_data: questionsData
  });
  report.unauthorizedExamWriteBlocked = Boolean(forgedExamError);
  if (!report.unauthorizedExamWriteBlocked) throw new Error('A student was able to create an exam.');

  const { error: studentProvisionError } = await firstClient.functions.invoke('manage-student', {
    body: { action: 'create', studentId: `${prefix}-FORGED`, name: 'Forged Student', password: studentPassword, className, section: 'A' }
  });
  report.studentProvisioningBlocked = [401, 403].includes(Number(studentProvisionError?.context?.status));
  if (!report.studentProvisioningBlocked) {
    if (studentProvisionError) {
      throw new Error(`Student provisioning denial was not authoritative (${await functionErrorSummary(studentProvisionError)}).`, {
        cause: studentProvisionError
      });
    }
    throw new Error('A student was able to provision another student.');
  }

  const adminClient = createClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${adminAccessToken}` } }
  });
  const { data: provisionedStudent, error: provisionError } = await adminClient.functions.invoke('manage-student', {
    body: { action: 'create', studentId: `${prefix}-PROVISIONED`, name: 'Provisioned Student', password: studentPassword, className, section: 'A' }
  });
  if (provisionError) {
    throw new Error(`Admin provisioning failed (${await functionErrorSummary(provisionError)}).`, { cause: provisionError });
  }
  if (!provisionedStudent?.id) throw new Error('Admin provisioning did not return a student ID.');
  authIds.push(provisionedStudent.id);
  const { data: provisionedProfile, error: provisionedProfileError } = await admin
    .from('students').select('student_id, class, section').eq('id', provisionedStudent.id).single();
  const { data: provisionedRole, error: provisionedRoleError } = await admin
    .from('profiles').select('role').eq('id', provisionedStudent.id).single();
  if (provisionedProfileError || provisionedRoleError
      || provisionedProfile?.student_id !== `${prefix}-PROVISIONED`
      || provisionedProfile?.class !== className || provisionedProfile?.section !== 'A'
      || provisionedRole?.role !== 'student') {
    throw new Error('Admin provisioning returned success without a usable, correctly assigned student profile.');
  }
  report.adminProvisionedStudent = true;

  const submissions = await limit(sessions, 16, async ({ student, client, correctTarget, submissionResponses }) => {
    const { data, error } = await timed(latencyMs.submit, () => client.rpc('submit_exam', {
      exam_id_param: examId, responses_param: submissionResponses
    }));
    if (error) throw error;
    const expectedIncorrect = questionCount - correctTarget;
    const expectedScore = (correctTarget * 4) - expectedIncorrect;
    if (Number(data.totalScore) !== expectedScore
        || Number(data.correct) !== correctTarget
        || Number(data.incorrect) !== expectedIncorrect
        || Number(data.unattempted) !== 0) {
      throw new Error(`Unexpected server score: ${JSON.stringify(data)}`);
    }
    const { data: retryData, error: retryError } = await timed(latencyMs.retry, () => client.rpc('submit_exam', {
      exam_id_param: examId,
      responses_param: submissionResponses
    }));
    if (retryError) throw retryError;
    for (const key of ['totalScore', 'maxScore', 'correct', 'incorrect', 'unattempted']) {
      if (Number(retryData?.[key]) !== Number(data?.[key])) {
        throw new Error(`Idempotent retry changed ${key} for ${student.studentId}.`);
      }
    }
    return { student, correctTarget, data };
  });
  report.submittedResults = submissions.length;
  report.idempotentSubmissionRetries = submissions.length;

  const { count: resultCount, error: resultCountError } = await admin
    .from('student_results').select('*', { count: 'exact', head: true }).eq('exam_id', examId);
  if (resultCountError) throw resultCountError;
  if (resultCount !== students.length) throw new Error(`Expected 80 saved results, found ${resultCount}.`);

  const { data: storedResults, error: storedResultsError } = await admin
    .from('student_results')
    .select('student_id, total_score, correct, incorrect, unattempted')
    .eq('exam_id', examId);
  if (storedResultsError) throw storedResultsError;
  const expectedCorrectByStudent = new Map(sessions.map(({ student, correctTarget }) => [student.studentId, correctTarget]));
  const storedStudentIds = new Set();
  for (const row of storedResults || []) {
    const expectedCorrect = expectedCorrectByStudent.get(row.student_id);
    const expectedIncorrect = questionCount - expectedCorrect;
    const expectedScore = (expectedCorrect * 4) - expectedIncorrect;
    if (!expectedCorrect
        || storedStudentIds.has(row.student_id)
        || Number(row.correct) !== expectedCorrect
        || Number(row.incorrect) !== expectedIncorrect
        || Number(row.unattempted) !== 0
        || Number(row.total_score) !== expectedScore) {
      throw new Error(`Lost, duplicated, or cross-account grading detected for ${row.student_id}.`);
    }
    storedStudentIds.add(row.student_id);
  }
  if (storedStudentIds.size !== students.length) throw new Error('Not every candidate has one verified result.');
  report.zeroLostOrCrossAccountAnswers = true;
  report.zeroDuplicateResults = true;

  const { data: foreignResults, error: foreignResultsError } = await firstClient
    .from('student_results')
    .select('student_id')
    .neq('student_id', sessions[0].student.studentId);
  report.crossAccountResultsHidden = Boolean(foreignResultsError) || (foreignResults || []).length === 0;
  if (!report.crossAccountResultsHidden) throw new Error('A student could read another candidate\'s result.');

  const { count: sessionCount, error: sessionCountError } = await admin
    .from('active_sessions').select('*', { count: 'exact', head: true }).eq('exam_id', examId);
  if (sessionCountError) throw sessionCountError;
  if (sessionCount !== 0) throw new Error(`Expected 0 remaining sessions, found ${sessionCount}.`);
  report.zeroUnhandledServerErrors = true;
  report.durationMs = Date.now() - startedAt;
  report.latencyMs = Object.fromEntries(Object.entries(latencyMs).map(([name, values]) => [name, {
    samples: values.length,
    p50: percentile(values, 50),
    p95: percentile(values, 95),
    p99: percentile(values, 99),
    max: Number(Math.max(...values).toFixed(1))
  }]));
} finally {
  await Promise.all(channels.map(channel => channel.unsubscribe().catch(() => undefined)));
  // Submitted results are intentionally immutable. Do not claim that deleting
  // Auth users cleans the rehearsal. Reset this disposable staging project from
  // its baseline after saving the JSON report.
  report.cleanupCompleted = false;
  report.stagingResetRequired = true;
}

console.log(JSON.stringify(report));
