import { test, expect } from '@playwright/test';
import { fixturesFor } from './support/fixtures.mjs';

const loginStudent = async (page, credentials, { expectTakeover = false } = {}) => {
  await page.goto('/');
  await page.getByLabel('Student ID').fill(credentials.student.studentId);
  await page.getByLabel('Password').fill(credentials.student.password);
  await page.getByRole('button', { name: 'Login' }).click();

  if (expectTakeover) {
    const warning = page.getByRole('dialog', { name: 'Notification' });
    await expect(warning).toContainText('replaced another active device');
    await expect(warning).toContainText('latest answers already confirmed by the exam server');
    await warning.getByRole('button', { name: 'OK' }).click();
  }

  await expect(page.getByText('Your Assigned Examinations')).toBeVisible();
};

const openExam = async (page, exam) => {
  const examCard = page.locator('.student-exam-card').filter({ hasText: exam.title });
  await expect(examCard).toBeVisible();
  await examCard.getByRole('button', { name: /Start Exam|Resume Exam/ }).click();
  await expect(page.getByRole('heading', { name: 'Exam Instructions' })).toBeVisible();
  await page.getByLabel('I have read and understood the instructions.').check();
  await page.getByRole('button', { name: 'Start Exam' }).click();
  await expect(page.getByRole('heading', { name: exam.title })).toBeVisible();
};

test('newest student login takes over atomically and the old device becomes read-only', async ({ browser }, testInfo) => {
  const fixture = fixturesFor(testInfo.project.name);
  const takeoverCredentials = { student: fixture.credentials.takeoverStudent };
  const oldContext = await browser.newContext();
  const newContext = await browser.newContext();
  const oldPage = await oldContext.newPage();
  const newPage = await newContext.newPage();

  try {
    await loginStudent(oldPage, takeoverCredentials);
    await openExam(oldPage, fixture.exam);
    await oldPage.getByRole('radio', { name: /B\.\s*Second/ }).check();
    await oldPage.getByRole('button', { name: /Save & Next/ }).click();
    await expect(oldPage.getByTitle('All responses saved to server')).toBeVisible();

    await loginStudent(newPage, takeoverCredentials, { expectTakeover: true });

    const oldDeviceWarning = oldPage.getByRole('dialog', { name: 'Notification' });
    await expect(oldDeviceWarning).toContainText('replaced by another device', { timeout: 20_000 });
    await expect(oldPage.getByRole('button', { name: /Save & Next/ })).toHaveCount(0);
    const recoveryCopy = await oldPage.evaluate(() => localStorage.getItem('cbt_active_exam_session'));
    expect(recoveryCopy).not.toBeNull();

    await openExam(newPage, fixture.exam);
    await newPage.getByRole('button', { name: 'Physics' }).click();
    await expect(newPage.getByRole('radio', { name: /B\.\s*Second/ })).toBeChecked();
  } finally {
    await oldContext.close();
    await newContext.close();
  }
});
