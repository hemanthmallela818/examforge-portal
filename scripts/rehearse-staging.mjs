import { createClient } from '@supabase/supabase-js';

const url = process.env.REHEARSAL_SUPABASE_URL;
const anonKey = process.env.REHEARSAL_SUPABASE_ANON_KEY;
const serviceKey = process.env.REHEARSAL_SUPABASE_SERVICE_ROLE_KEY;
const adminAccessToken = process.env.REHEARSAL_ADMIN_AAL2_ACCESS_TOKEN;
const expectedProjectRef = process.env.REHEARSAL_EXPECTED_PROJECT_REF;
const destructiveConfirmation = process.env.REHEARSAL_CONFIRM_DISPOSABLE;

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

const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
const prefix = `REHEARSAL-${Date.now()}`;
const className = `${prefix}-CLASS`;
const studentPassword = 'Rehearsal!12345';
const students = Array.from({ length: 80 }, (_, index) => ({
  studentId: `${prefix}-S${String(index + 1).padStart(3, '0')}`,
  email: `${prefix.toLowerCase()}-s${String(index + 1).padStart(3, '0')}@rehearsal.local`,
  name: `Rehearsal Student ${index + 1}`
}));

const questionCount = 80;
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

const withRetries = async (task, attempts = 5) => {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await task();
    } catch (error) {
      lastError = error;
      if (error?.status !== 429 || attempt === attempts - 1) throw error;
      await wait(1000 * (attempt + 1));
    }
  }
  throw lastError;
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
  // limits when all test accounts originate from one IP address.
  const authenticated = await limit(created, 4, async student => {
    const client = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
    const authData = await withRetries(async () => {
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
    const { data: session, error: sessionError } = await client.rpc('start_exam_session', {
      exam_id_param: examId,
      exam_data_param: visibleExam.questions_data,
      responses_param: candidateResponses.grouped
    });
    if (sessionError) throw sessionError;
    const { error: autosaveError } = await client.rpc('sync_active_session_progress', {
      exam_id_param: examId,
      responses_param: session.user_responses,
      expected_version_param: session.version
    });
    if (autosaveError) throw autosaveError;
    return { student, client, session, correctTarget, submissionResponses: candidateResponses.flattened };
  });
  report.startedSessions = sessions.length;
  report.autosavedSessions = sessions.length;
  report.answersHidden = true;

  const subscriptionResults = await Promise.all(sessions.map(({ client }, index) => subscribe(client, `${prefix}-channel-${index}`)));
  subscriptionResults.forEach(result => channels.push(result.channel));
  report.realtimeSubscribed = subscriptionResults.filter(result => result.status === 'SUBSCRIBED').length;
  if (report.realtimeSubscribed !== students.length) throw new Error(`Only ${report.realtimeSubscribed}/80 Realtime channels subscribed.`);

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
  report.studentProvisioningBlocked = Boolean(studentProvisionError);
  if (!report.studentProvisioningBlocked) throw new Error('A student was able to provision another student.');

  const adminClient = createClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${adminAccessToken}` } }
  });
  const { data: provisionedStudent, error: provisionError } = await adminClient.functions.invoke('manage-student', {
    body: { action: 'create', studentId: `${prefix}-PROVISIONED`, name: 'Provisioned Student', password: studentPassword, className, section: 'A' }
  });
  if (provisionError || !provisionedStudent?.id) throw provisionError || new Error('Admin provisioning did not return a student ID.');
  authIds.push(provisionedStudent.id);
  report.adminProvisionedStudent = true;

  const submissions = await limit(sessions, 16, async ({ student, client, correctTarget, submissionResponses }) => {
    const { data, error } = await client.rpc('submit_exam', { exam_id_param: examId, responses_param: submissionResponses });
    if (error) throw error;
    const expectedIncorrect = questionCount - correctTarget;
    const expectedScore = (correctTarget * 4) - expectedIncorrect;
    if (Number(data.totalScore) !== expectedScore
        || Number(data.correct) !== correctTarget
        || Number(data.incorrect) !== expectedIncorrect
        || Number(data.unattempted) !== 0) {
      throw new Error(`Unexpected server score: ${JSON.stringify(data)}`);
    }
    const { data: retryData, error: retryError } = await client.rpc('submit_exam', {
      exam_id_param: examId,
      responses_param: submissionResponses
    });
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
} finally {
  await Promise.all(channels.map(channel => channel.unsubscribe().catch(() => undefined)));
  // Submitted results are intentionally immutable. Do not claim that deleting
  // Auth users cleans the rehearsal. Reset this disposable staging project from
  // its baseline after saving the JSON report.
  report.cleanupCompleted = false;
  report.stagingResetRequired = true;
}

console.log(JSON.stringify(report));
