import { test, expect } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import { fixturesFor } from './support/fixtures.mjs';
import { readLocalSupabase } from './support/local-supabase.mjs';

const loginStudent = async (page, credentials) => {
  await page.goto('/');
  await page.getByLabel('Student ID').fill(credentials.student.studentId);
  await page.getByLabel('Password').fill(credentials.student.password);
  await page.getByRole('button', { name: 'Login' }).click();
  await expect(page.getByText('Your Assigned Examinations')).toBeVisible();
};

const waitForConfirmedAutosave = (page, subject, expectedAnswer) => page.waitForResponse(async (response) => {
  if (
    response.request().method() !== 'POST'
    || !response.url().includes('/rest/v1/rpc/sync_active_session_progress')
    || !response.ok()
  ) return false;

  const request = response.request().postDataJSON();
  if (request?.responses_param?.[subject]?.[0]?.selectedOption !== expectedAnswer) return false;
  const result = await response.json().catch(() => null);
  return result?.success === true && result?.conflict === false;
});

test('student reload is blocked, admin re-grants access, and offline answers submit once', async ({ page, context, browser }, testInfo) => {
  const fixture = fixturesFor(testInfo.project.name);
  await loginStudent(page, fixture.credentials);

  const examCard = page.locator('.student-exam-card').filter({ hasText: fixture.exam.title });
  await expect(examCard).toBeVisible();
  await examCard.getByRole('button', { name: /Start Exam/ }).click();
  await expect(page.getByRole('heading', { name: 'Exam Instructions' })).toBeVisible();
  await page.getByLabel('I have read and understood the instructions.').check();
  await page.getByRole('button', { name: 'Start Exam' }).click();

  await expect(page.getByRole('heading', { name: fixture.exam.title })).toBeVisible();
  const physicsAutosave = waitForConfirmedAutosave(page, 'Physics', 1);
  await page.getByRole('radio', { name: /B\.\s*Second/ }).check();
  await page.getByRole('button', { name: /Save & Next/ }).click();
  await physicsAutosave;
  await expect(page.getByTitle('All responses saved to server')).toBeVisible();

  const local = readLocalSupabase();
  const service = createClient(local.url, local.serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false }
  });
  const sessionId = `${fixture.credentials.student.id}_${fixture.exam.id}`;
  const readSession = async () => {
    const { data, error } = await service.from('active_sessions')
      .select('status, deadline_at, access_generation, user_responses')
      .eq('id', sessionId).single();
    expect(error).toBeNull();
    return data;
  };
  const originalSession = await readSession();

  // Reload is now a security exit. Only an administrator can allow resumption.
  await page.reload();
  await expect(page.getByText('Your Assigned Examinations')).toBeVisible();
  await expect(page.getByRole('button', { name: /Save & Next/ })).toHaveCount(0);
  await expect.poll(async () => (await readSession()).status).toBe('TERMINATED');
  await expect(examCard.getByText('Blocked', { exact: true })).toBeVisible();
  await expect(examCard.getByRole('button', { name: /Start Exam|Resume Exam/ })).toHaveCount(0);

  const adminContext = await browser.newContext();
  try {
    const adminPage = await adminContext.newPage();
    await adminPage.goto('/');
    await adminPage.getByRole('tab', { name: 'Admin Login' }).click();
    await adminPage.getByLabel('Admin Email').fill(fixture.credentials.root.email);
    await adminPage.getByLabel('Password').fill(fixture.credentials.root.password);
    await adminPage.getByRole('button', { name: 'Login' }).click();
    await expect(adminPage.getByRole('heading', { name: 'Dashboard Overview' })).toBeVisible();
    await adminPage.getByRole('button', { name: /Operations & Audit/ }).click();
    const row = adminPage.getByRole('row').filter({ hasText: fixture.credentials.student.studentId });
    await row.getByRole('button', { name: 'Re-grant Access' }).click();
    await adminPage.getByRole('dialog', { name: 'Confirmation Required' })
      .getByRole('button', { name: 'Confirm' }).click();
    await expect.poll(async () => (await readSession()).status).toBe('IN_PROGRESS');
  } finally {
    await adminContext.close();
  }
  const regrantedSession = await readSession();
  expect(regrantedSession.deadline_at).toBe(originalSession.deadline_at);
  expect(regrantedSession.access_generation).toBe(originalSession.access_generation + 1);
  expect(regrantedSession.user_responses).toEqual(originalSession.user_responses);

  await page.bringToFront();
  await page.reload();
  await examCard.getByRole('button', { name: /Resume Exam/ }).click();
  await page.getByLabel('I have read and understood the instructions.').check();
  await page.getByRole('button', { name: 'Start Exam' }).click();
  await expect(page.getByRole('heading', { name: fixture.exam.title })).toBeVisible();
  await page.getByRole('button', { name: 'Physics' }).click();
  await expect(page.getByRole('radio', { name: /B\.\s*Second/ })).toBeChecked();

  await page.getByRole('button', { name: 'Chemistry' }).click();
  await context.setOffline(true);
  await expect(page.getByTitle('Offline', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: /Continue Answering Offline/ }).click();
  await page.getByLabel('Your Numerical Answer:').fill('0');
  await page.getByRole('button', { name: /Save & Next/ }).click();
  await expect(page.getByTitle('Offline: Responses saved to local storage')).toBeVisible();

  const chemistryAutosave = waitForConfirmedAutosave(page, 'Chemistry', '0');
  await context.setOffline(false);
  await chemistryAutosave;
  await expect(page.getByTitle('All responses saved to server')).toBeVisible({ timeout: 20_000 });
  await page.getByRole('button', { name: 'Mathematics' }).click();
  // Multiple correct: ticking B and D saves the canonical "1,3".
  const mathematicsAutosave = waitForConfirmedAutosave(page, 'Mathematics', '1,3');
  await page.getByRole('checkbox', { name: /B\.\s*Two/ }).check();
  await page.getByRole('checkbox', { name: /D\.\s*Four/ }).check();
  await page.getByRole('button', { name: /Save & Next/ }).click();
  await mathematicsAutosave;
  await expect(page.getByTitle('All responses saved to server')).toBeVisible();

  await page.getByRole('button', { name: 'Submit Exam' }).click();
  const submitDialog = page.getByRole('dialog', { name: 'Submit Exam?' });
  await expect(submitDialog).toBeVisible();
  await submitDialog.getByRole('button', { name: 'Yes, Submit' }).click();
  await expect(page.getByRole('heading', { name: 'Exam Results' })).toBeVisible();
  await expect(page.getByText('12 / 12')).toBeVisible();

  const { count, error } = await service
    .from('student_results')
    .select('*', { count: 'exact', head: true })
    .eq('student_id', fixture.credentials.student.studentId)
    .eq('exam_id', fixture.exam.id);
  expect(error).toBeNull();
  expect(count).toBe(1);

  await page.getByRole('button', { name: /Return to Dashboard/ }).click();
  const completedExamCard = page.locator('.student-exam-card').filter({ hasText: fixture.exam.title });
  await expect(completedExamCard).toBeVisible();
  await completedExamCard.getByRole('button', { name: /View Scorecard/ }).click();
  await expect(page.getByRole('heading', { name: 'Exam Results' })).toBeVisible();
  await expect(page.getByText('12 / 12')).toBeVisible();
});
