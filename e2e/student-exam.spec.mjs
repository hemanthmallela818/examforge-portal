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

test('student reloads, works offline, reconnects, submits once, and revisits the result', async ({ page, context }, testInfo) => {
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

  await page.reload();
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
  const mathematicsAutosave = waitForConfirmedAutosave(page, 'Mathematics', 2);
  await page.getByRole('radio', { name: /C\.\s*Three/ }).check();
  await page.getByRole('button', { name: /Save & Next/ }).click();
  await mathematicsAutosave;
  await expect(page.getByTitle('All responses saved to server')).toBeVisible();

  await page.getByRole('button', { name: 'Submit Exam' }).click();
  const submitDialog = page.getByRole('dialog', { name: 'Submit Exam?' });
  await expect(submitDialog).toBeVisible();
  await submitDialog.getByRole('button', { name: 'Yes, Submit' }).click();
  await expect(page.getByRole('heading', { name: 'Exam Results' })).toBeVisible();
  await expect(page.getByText('12 / 12')).toBeVisible();

  const local = readLocalSupabase();
  const service = createClient(local.url, local.serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false }
  });
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
