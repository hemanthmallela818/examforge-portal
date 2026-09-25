import { test, expect } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import { fixturesFor } from './support/fixtures.mjs';
import { readLocalSupabase } from './support/local-supabase.mjs';

const jsonError = (status, message) => ({
  status,
  contentType: 'application/json',
  body: JSON.stringify({ code: `E2E_${status}`, message, details: null, hint: null })
});

const loginAdministrator = async (page, account) => {
  await page.goto('/');
  await page.getByRole('tab', { name: 'Admin Login' }).click();
  await page.getByLabel('Admin Email').fill(account.email);
  await page.getByLabel('Password').fill(account.password);
  await page.getByRole('button', { name: 'Login' }).click();

  await expect(page.getByRole('heading', { name: 'Dashboard Overview' })).toBeVisible();
};

const loginStudent = async (page, student) => {
  await page.goto('/');
  await page.getByLabel('Student ID').fill(student.studentId);
  await page.getByLabel('Password').fill(student.password);
  await page.getByRole('button', { name: 'Login' }).click();
  await expect(page.getByText('Your Assigned Examinations')).toBeVisible();
};

const beginExam = async (page, fixture, student) => {
  await loginStudent(page, student);
  const examCard = page.locator('.student-exam-card').filter({ hasText: fixture.exam.title });
  await expect(examCard).toBeVisible();
  await examCard.getByRole('button', { name: /Start Exam/ }).click();
  await expect(page.getByRole('heading', { name: 'Exam Instructions' })).toBeVisible();
  await page.getByLabel('I have read and understood the instructions.').check();
  await page.getByRole('button', { name: 'Start Exam', exact: true }).click();
  await expect(page.getByRole('heading', { name: fixture.exam.title })).toBeVisible();
};

test('administrator data failures are visible, bounded, and recover through explicit retry', async ({ page }, testInfo) => {
  const fixture = fixturesFor(testInfo.project.name);
  const injectedStatuses = [500, 429, 409];
  let attempts = 0;

  await page.route('**/rest/v1/rpc/get_admin_exam_list_page', async route => {
    const attempt = attempts++;
    if (attempt < injectedStatuses.length) {
      const status = injectedStatuses[attempt];
      await route.fulfill(jsonError(status, `Injected ${status} administrator list failure`));
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 750));
    await route.continue();
  });

  await loginAdministrator(page, fixture.credentials.reliabilityAdmin);
  const failure = page.getByRole('alert').filter({ hasText: 'Some administrator data could not be refreshed.' });
  await expect(failure).toBeVisible();

  for (let expectedAttempts = 2; expectedAttempts <= 4; expectedAttempts += 1) {
    await failure.getByRole('button', { name: 'Retry failed data' }).click();
    await expect.poll(() => attempts).toBe(expectedAttempts);
    if (expectedAttempts < 4) await expect(failure).toBeVisible();
  }

  await expect(page.getByText('Refreshing administrator data…', { exact: true })).toBeVisible();
  await expect(failure).toHaveCount(0);
  await expect(page.locator('.admin-exam-card').filter({ hasText: fixture.exam.title })).toBeVisible();
});

test('student dashboard recovers from 401 and 403 REST failures without reloading the page', async ({ page }, testInfo) => {
  const fixture = fixturesFor(testInfo.project.name);
  let resultReads = 0;
  let examReads = 0;
  let rejectExamReads = false;

  await page.route('**/rest/v1/student_results*', async route => {
    resultReads += 1;
    if (resultReads === 1) await route.fulfill(jsonError(401, 'Injected expired JWT response'));
    else await route.continue();
  });
  await page.route('**/rest/v1/cbt_exams*', async route => {
    examReads += 1;
    if (rejectExamReads) {
      await new Promise(resolve => setTimeout(resolve, 500));
      await route.fulfill(jsonError(403, 'Injected forbidden response'));
    }
    else await route.continue();
  });

  await loginStudent(page, fixture.credentials.reliabilityStudent);
  const error = page.getByRole('alert').filter({ hasText: 'Failed to fetch exams' });
  await expect(error).toBeVisible();
  rejectExamReads = true;
  await error.getByRole('button', { name: 'Retry dashboard' }).click();
  await expect.poll(() => examReads).toBeGreaterThanOrEqual(1);
  await expect(error).toBeVisible();
  rejectExamReads = false;
  await error.getByRole('button', { name: 'Retry dashboard' }).click();
  await expect(page.locator('.student-exam-card').filter({ hasText: fixture.exam.title })).toBeVisible();
  expect(resultReads).toBeGreaterThanOrEqual(3);
  expect(examReads).toBeGreaterThanOrEqual(2);
});

test('a response lost after committed submission recovers idempotently with one result', async ({ page }, testInfo) => {
  const fixture = fixturesFor(testInfo.project.name);
  const student = fixture.credentials.recoveryStudent;
  await beginExam(page, fixture, student);
  await page.getByRole('radio', { name: /B\.\s*Second/ }).check();
  await page.getByRole('button', { name: /Save & Next/ }).click();
  await expect(page.getByTitle('All responses saved to server')).toBeVisible();

  let submitAttempts = 0;
  let committedResponseStatus = 0;
  await page.route('**/rest/v1/rpc/submit_exam', async route => {
    submitAttempts += 1;
    if (submitAttempts === 1) {
      const response = await route.fetch();
      committedResponseStatus = response.status();
      await route.abort('failed');
      return;
    }
    await route.continue();
  });

  await page.getByRole('button', { name: 'Submit Exam' }).click();
  const confirmation = page.getByRole('dialog', { name: 'Submit Exam?' });
  await confirmation.getByRole('button', { name: 'Yes, Submit' }).click();
  // The lost response is a transient network failure, so the client retries the
  // idempotent submit automatically and the candidate reaches the result without
  // a manual retry. The retry returns the already-committed result.
  await expect(page.getByRole('heading', { name: 'Exam Results' })).toBeVisible({ timeout: 20000 });
  expect(committedResponseStatus).toBe(200);
  expect(submitAttempts).toBe(2);

  const local = readLocalSupabase();
  const service = createClient(local.url, local.serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false }
  });
  const { count, error } = await service
    .from('student_results')
    .select('*', { count: 'exact', head: true })
    .eq('student_id', student.studentId)
    .eq('exam_id', fixture.exam.id);
  expect(error).toBeNull();
  expect(count).toBe(1);
});

test('storage quota denial blocks exam start while a Realtime outage preserves REST access', async ({ page }, testInfo) => {
  const fixture = fixturesFor(testInfo.project.name);
  let realtimeAttempts = 0;
  await page.routeWebSocket(/\/realtime\/v1\/websocket/, websocket => {
    realtimeAttempts += 1;
    websocket.close();
  });
  await page.addInitScript(() => {
    const nativeSetItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function setItemWithQuotaFailure(key, value) {
      if (String(key).startsWith('__cbt_storage_probe_')) {
        throw new DOMException('Injected quota exhaustion', 'QuotaExceededError');
      }
      return nativeSetItem.call(this, key, value);
    };
  });

  await loginStudent(page, fixture.credentials.storageStudent);
  await expect.poll(() => realtimeAttempts).toBeGreaterThan(0);
  const examCard = page.locator('.student-exam-card').filter({ hasText: fixture.exam.title });
  await expect(examCard).toBeVisible();
  await examCard.getByRole('button', { name: /Start Exam/ }).click();
  await expect(page.getByText('This browser cannot safely start the exam.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Browser Storage Required to Start' })).toBeDisabled();
});
