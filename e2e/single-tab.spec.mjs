import { test, expect } from '@playwright/test';
import { fixturesFor } from './support/fixtures.mjs';

const loginStudent = async (page, credentials) => {
  await page.goto('/');
  await page.getByLabel('Student ID').fill(credentials.student.studentId);
  await page.getByLabel('Password').fill(credentials.student.password);
  await page.getByRole('button', { name: 'Login' }).click();
  await expect(page.getByText('Your Assigned Examinations')).toBeVisible();
};

test('the exam runs in one tab only; a second tab is blocked until the first closes', async ({ context }, testInfo) => {
  const fixture = fixturesFor(testInfo.project.name);
  const firstTab = await context.newPage();
  await loginStudent(firstTab, { student: fixture.credentials.singleTabStudent });
  const examCard = firstTab.locator('.student-exam-card').filter({ hasText: fixture.exam.title });
  await examCard.getByRole('button', { name: /Start Exam|Resume/ }).click();
  await firstTab.getByLabel('I have read and understood the instructions.').check();
  await firstTab.getByRole('button', { name: 'Start Exam' }).click();
  await expect(firstTab.getByRole('heading', { name: fixture.exam.title })).toBeVisible();

  // Same browser, second tab: the duplicated tab restores straight into the exam.
  const secondTab = await context.newPage();
  const storedSession = await firstTab.evaluate(() => JSON.stringify(sessionStorage));
  await secondTab.addInitScript(entries => {
    for (const [key, value] of Object.entries(JSON.parse(entries))) sessionStorage.setItem(key, value);
  }, storedSession);
  await secondTab.goto('/exam');
  await expect(secondTab.getByRole('heading', { name: 'This exam is already open in another tab' })).toBeVisible();
  await expect(secondTab.getByRole('button', { name: 'Continue in this tab' })).toBeDisabled();
  await expect(secondTab.getByRole('heading', { name: fixture.exam.title })).toHaveCount(0);
  // The exam in the first tab is untouched.
  await expect(firstTab.getByRole('heading', { name: fixture.exam.title })).toBeVisible();

  await firstTab.close();
  await expect(secondTab.getByRole('heading', { name: 'The other exam tab was closed' })).toBeVisible();
  await secondTab.getByRole('button', { name: 'Continue in this tab' }).click();
  await expect(secondTab.getByRole('heading', { name: fixture.exam.title })).toBeVisible();
});
