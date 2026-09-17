import { mkdir, writeFile } from 'node:fs/promises';
import { createClient } from '@supabase/supabase-js';
import { readLocalSupabase } from './support/local-supabase.mjs';

const PROJECTS = ['chromium', 'firefox', 'webkit'];
const ADMIN_PASSWORD = 'E2E-Admin!2026';
const STUDENT_PASSWORD = 'E2E-Student!2026';
const CLASS_NAME = 'E2E Class 12';
const SECTION = 'A';
const EXAM_TITLE_PREFIX = 'E2E Active Examination';

const questionData = {
  duration: 30,
  totalQuestions: 3,
  marksCorrect: 4,
  marksIncorrect: -1,
  subjects: ['Physics', 'Chemistry', 'Mathematics'],
  questions: {
    Physics: [{
      id: 'e2e-physics-1', subject: 'Physics', type: 'MCQ',
      text: 'Which option is correct for the browser test?',
      options: ['First', 'Second', 'Third', 'Fourth'], correctAnswer: '1',
      hasImageOrDiagram: false
    }],
    Chemistry: [{
      id: 'e2e-chemistry-1', subject: 'Chemistry', type: 'NUMERICAL',
      text: 'Enter the numerical value zero.', options: [], correctAnswer: '0',
      hasImageOrDiagram: false
    }],
    Mathematics: [{
      id: 'e2e-mathematics-1', subject: 'Mathematics', type: 'MCQ',
      text: 'Select the third option.', options: ['One', 'Two', 'Three', 'Four'],
      correctAnswer: '2', hasImageOrDiagram: false
    }]
  }
};

export default async function globalSetup() {
  const local = readLocalSupabase();
  const service = createClient(local.url, local.serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false }
  });

  const { error: classError } = await service.from('classes').upsert({
    name: CLASS_NAME,
    sections: [SECTION]
  }, { onConflict: 'name' });
  if (classError) throw new Error(`Could not create E2E class: ${classError.message}`);

  const credentials = {};
  const { data: listedUsers, error: listUsersError } = await service.auth.admin.listUsers({
    page: 1,
    perPage: 1000
  });
  if (listUsersError) throw new Error(`Could not inspect existing E2E users: ${listUsersError.message}`);
  const usersByEmail = new Map(
    (listedUsers?.users || []).map(user => [String(user.email || '').toLowerCase(), user])
  );

  const finalizeAccount = async (user, label) => {
    const { error } = await service.rpc('complete_account_provisioning', { account_id_param: user.id });
    if (error) {
      await service.auth.admin.deleteUser(user.id);
      throw new Error(`Could not finalize ${label}: ${error.message}`);
    }
  };

  const clearMfaFactors = async (user, label) => {
    const { data, error } = await service.auth.admin.mfa.listFactors({ userId: user.id });
    if (error) throw new Error(`Could not inspect MFA factors for ${label}: ${error.message}`);
    for (const factor of data?.factors || []) {
      const { error: deleteError } = await service.auth.admin.mfa.deleteFactor({
        userId: user.id,
        id: factor.id
      });
      if (deleteError) throw new Error(`Could not reset MFA for ${label}: ${deleteError.message}`);
    }
  };

  const ensureUser = async ({ email, password, userMetadata, appMetadata, label }) => {
    const existing = usersByEmail.get(email.toLowerCase());
    if (existing) {
      const { data, error } = await service.auth.admin.updateUserById(existing.id, {
        password,
        user_metadata: userMetadata,
        app_metadata: appMetadata
      });
      if (error || !data.user) throw new Error(`Could not refresh ${label}: ${error?.message}`);
      await finalizeAccount(data.user, label);
      return data.user;
    }

    const { data, error } = await service.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: userMetadata,
      app_metadata: appMetadata
    });
    if (error || !data.user) throw new Error(`Could not create ${label}: ${error?.message}`);
    usersByEmail.set(email.toLowerCase(), data.user);
    await finalizeAccount(data.user, label);
    return data.user;
  };

  const ensureStudentFixture = async ({ project, studentId, purpose }) => ensureUser({
    email: `${studentId.toLowerCase()}@student.com`,
    password: STUDENT_PASSWORD,
    userMetadata: {
      student_id: studentId,
      name: `E2E ${project} ${purpose} Student`,
      class: CLASS_NAME,
      section: SECTION
    },
    appMetadata: { provisioned_by: 'admin', account_type: 'student' },
    label: `${project} E2E ${purpose.toLowerCase()} student`
  });

  for (const project of PROJECTS) {
    const suffix = project === 'chromium' ? 'CHR' : project === 'firefox' ? 'FOX' : 'WEB';
    const studentId = `E2E${suffix}001`;
    const authStudentId = `E2E${suffix}101`;
    const takeoverStudentId = `E2E${suffix}201`;
    const reliabilityStudentId = `E2E${suffix}301`;
    const recoveryStudentId = `E2E${suffix}401`;
    const storageStudentId = `E2E${suffix}501`;
    const accessibilityStudentId = `E2E${suffix}601`;
    const adminEmail = `admin-${project}@e2e.local`;
    const operationsAdminEmail = `operations-${project}@e2e.local`;
    const exportAdminEmail = `exports-${project}@e2e.local`;
    const reliabilityAdminEmail = `reliability-${project}@e2e.local`;
    const accessibilityAdminEmail = `accessibility-${project}@e2e.local`;
    const studentEmail = `${studentId.toLowerCase()}@student.com`;

    const adminUser = await ensureUser({
      email: adminEmail,
      password: ADMIN_PASSWORD,
      userMetadata: { name: `E2E ${project} Administrator` },
      appMetadata: { provisioned_by: 'admin', account_type: 'admin' },
      label: `${project} E2E administrator`
    });
    await clearMfaFactors(adminUser, `${project} E2E administrator`);

    const operationsAdminUser = await ensureUser({
      email: operationsAdminEmail,
      password: ADMIN_PASSWORD,
      userMetadata: { name: `E2E ${project} Operations Administrator` },
      appMetadata: { provisioned_by: 'admin', account_type: 'admin' },
      label: `${project} E2E operations administrator`
    });
    await clearMfaFactors(operationsAdminUser, `${project} E2E operations administrator`);

    const exportAdminUser = await ensureUser({
      email: exportAdminEmail,
      password: ADMIN_PASSWORD,
      userMetadata: { name: `E2E ${project} Export Administrator` },
      appMetadata: { provisioned_by: 'admin', account_type: 'admin' },
      label: `${project} E2E export administrator`
    });
    await clearMfaFactors(exportAdminUser, `${project} E2E export administrator`);

    const reliabilityAdminUser = await ensureUser({
      email: reliabilityAdminEmail,
      password: ADMIN_PASSWORD,
      userMetadata: { name: `E2E ${project} Reliability Administrator` },
      appMetadata: { provisioned_by: 'admin', account_type: 'admin' },
      label: `${project} E2E reliability administrator`
    });
    await clearMfaFactors(reliabilityAdminUser, `${project} E2E reliability administrator`);

    const accessibilityAdminUser = await ensureUser({
      email: accessibilityAdminEmail,
      password: ADMIN_PASSWORD,
      userMetadata: { name: `E2E ${project} Accessibility Administrator` },
      appMetadata: { provisioned_by: 'admin', account_type: 'admin' },
      label: `${project} E2E accessibility administrator`
    });
    await clearMfaFactors(accessibilityAdminUser, `${project} E2E accessibility administrator`);

    const studentUser = await ensureUser({
      email: studentEmail,
      password: STUDENT_PASSWORD,
      userMetadata: {
        student_id: studentId,
        name: `E2E ${project} Student`,
        class: CLASS_NAME,
        section: SECTION
      },
      appMetadata: { provisioned_by: 'admin', account_type: 'student' },
      label: `${project} E2E student`
    });

    const authStudentUser = await ensureUser({
      email: `${authStudentId.toLowerCase()}@student.com`,
      password: STUDENT_PASSWORD,
      userMetadata: {
        student_id: authStudentId,
        name: `E2E ${project} Authentication Student`,
        class: CLASS_NAME,
        section: SECTION
      },
      appMetadata: { provisioned_by: 'admin', account_type: 'student' },
      label: `${project} E2E authentication student`
    });

    const takeoverStudentUser = await ensureUser({
      email: `${takeoverStudentId.toLowerCase()}@student.com`,
      password: STUDENT_PASSWORD,
      userMetadata: {
        student_id: takeoverStudentId,
        name: `E2E ${project} Takeover Student`,
        class: CLASS_NAME,
        section: SECTION
      },
      appMetadata: { provisioned_by: 'admin', account_type: 'student' },
      label: `${project} E2E takeover student`
    });

    const reliabilityStudentUser = await ensureStudentFixture({
      project,
      studentId: reliabilityStudentId,
      purpose: 'Reliability'
    });
    const recoveryStudentUser = await ensureStudentFixture({
      project,
      studentId: recoveryStudentId,
      purpose: 'Recovery'
    });
    const storageStudentUser = await ensureStudentFixture({
      project,
      studentId: storageStudentId,
      purpose: 'Storage'
    });
    const accessibilityStudentUser = await ensureStudentFixture({
      project,
      studentId: accessibilityStudentId,
      purpose: 'Accessibility'
    });

    credentials[project] = {
      admin: { email: adminEmail, password: ADMIN_PASSWORD, id: adminUser.id },
      operationsAdmin: {
        email: operationsAdminEmail,
        password: ADMIN_PASSWORD,
        id: operationsAdminUser.id
      },
      exportAdmin: {
        email: exportAdminEmail,
        password: ADMIN_PASSWORD,
        id: exportAdminUser.id
      },
      reliabilityAdmin: {
        email: reliabilityAdminEmail,
        password: ADMIN_PASSWORD,
        id: reliabilityAdminUser.id
      },
      accessibilityAdmin: {
        email: accessibilityAdminEmail,
        password: ADMIN_PASSWORD,
        id: accessibilityAdminUser.id
      },
      student: { studentId, email: studentEmail, password: STUDENT_PASSWORD, id: studentUser.id },
      authStudent: {
        studentId: authStudentId,
        email: `${authStudentId.toLowerCase()}@student.com`,
        password: STUDENT_PASSWORD,
        id: authStudentUser.id
      },
      takeoverStudent: {
        studentId: takeoverStudentId,
        email: `${takeoverStudentId.toLowerCase()}@student.com`,
        password: STUDENT_PASSWORD,
        id: takeoverStudentUser.id
      },
      reliabilityStudent: {
        studentId: reliabilityStudentId,
        email: `${reliabilityStudentId.toLowerCase()}@student.com`,
        password: STUDENT_PASSWORD,
        id: reliabilityStudentUser.id
      },
      recoveryStudent: {
        studentId: recoveryStudentId,
        email: `${recoveryStudentId.toLowerCase()}@student.com`,
        password: STUDENT_PASSWORD,
        id: recoveryStudentUser.id
      },
      storageStudent: {
        studentId: storageStudentId,
        email: `${storageStudentId.toLowerCase()}@student.com`,
        password: STUDENT_PASSWORD,
        id: storageStudentUser.id
      },
      accessibilityStudent: {
        studentId: accessibilityStudentId,
        email: `${accessibilityStudentId.toLowerCase()}@student.com`,
        password: STUDENT_PASSWORD,
        id: accessibilityStudentUser.id
      }
    };
  }

  const fixtureStudentUserIds = Object.values(credentials).flatMap(({
    student,
    authStudent,
    takeoverStudent,
    reliabilityStudent,
    recoveryStudent,
    storageStudent,
    accessibilityStudent
  }) => [
    student.id,
    authStudent.id,
    takeoverStudent.id,
    reliabilityStudent.id,
    recoveryStudent.id,
    storageStudent.id,
    accessibilityStudent.id
  ]);
  const { error: resetClaimError } = await service
    .from('students')
    .update({ active_auth_session_id: null })
    .in('id', fixtureStudentUserIds);
  if (resetClaimError) {
    throw new Error(`Could not reset E2E student device claims: ${resetClaimError.message}`);
  }

  const { data: exam, error: examError } = await service.from('cbt_exams').insert({
    title: `${EXAM_TITLE_PREFIX} ${Date.now()}`,
    status: 'ACTIVE',
    class: CLASS_NAME,
    section: SECTION,
    questions_data: questionData
  }).select('id, title').single();
  if (examError || !exam) throw new Error(`Could not create E2E examination: ${examError?.message}`);

  const { data: reportExam, error: reportExamError } = await service.from('cbt_exams').insert({
    title: `E2E Results Archive ${Date.now()}`,
    status: 'ENDED',
    class: CLASS_NAME,
    section: SECTION,
    questions_data: questionData
  }).select('id, title').single();
  if (reportExamError || !reportExam) {
    throw new Error(`Could not create E2E results examination: ${reportExamError?.message}`);
  }

  const resultRows = Object.entries(credentials).map(([project, value], index) => ({
    exam_id: reportExam.id,
    student_id: value.student.studentId,
    student_name: `E2E ${project} Student`,
    total_score: 12 - index,
    max_score: 12,
    correct: 3,
    incorrect: 0,
    unattempted: 0,
    subject_scores: { Physics: 4, Chemistry: 4, Mathematics: 4 - index }
  }));
  const { error: resultError } = await service.from('student_results').insert(resultRows);
  if (resultError) throw new Error(`Could not create E2E result fixtures: ${resultError.message}`);

  await mkdir('e2e/.state', { recursive: true });
  await writeFile('e2e/.state/fixtures.json', JSON.stringify({
    local: { url: local.url, anonKey: local.anonKey },
    className: CLASS_NAME,
    section: SECTION,
    exam,
    reportExam,
    credentials
  }, null, 2));
}
