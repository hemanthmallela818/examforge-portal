import { test, expect } from '@playwright/test';
import { fixturesFor } from './support/fixtures.mjs';

const leaveFullscreen = page => page.evaluate(() => document.exitFullscreen());

test('blocked actions are not counted; leaving the exam gives numbered warnings, then ends it with a way out', async ({ page }, testInfo) => {
  const fixture = fixturesFor(testInfo.project.name);
  const credentials = fixture.credentials.lockdownStudent;
  await page.goto('/');
  await page.getByLabel('Student ID').fill(credentials.studentId);
  await page.getByLabel('Password').fill(credentials.password);
  await page.getByRole('button', { name: 'Login' }).click();
  await expect(page.getByText('Your Assigned Examinations')).toBeVisible();
  const card = page.locator('.student-exam-card').filter({ hasText: fixture.exam.title });
  await card.getByRole('button', { name: /Start Exam|Resume/ }).click();
  await page.getByLabel('I have read and understood the instructions.').check();
  await page.getByRole('button', { name: 'Start Exam' }).click();
  await expect(page.getByRole('heading', { name: fixture.exam.title })).toBeVisible();
  await expect.poll(() => page.evaluate(() => Boolean(document.fullscreenElement))).toBe(true);

  // Right-click and shortcut keys are blocked and explained, never counted.
  for (let i = 0; i < 4; i += 1) {
    await page.mouse.click(500, 300, { button: 'right' });
    await page.keyboard.press('Control+KeyU');
  }
  await expect(page.getByText('Right-click is disabled during the exam.').first()).toBeVisible();
  await expect(page.getByText(/Warning \d of 2/)).toHaveCount(0);

  // Leaving the exam: two visible warnings.
  for (const count of [1, 2]) {
    await leaveFullscreen(page);
    await expect(page.getByText(`Warning ${count} of 2`)).toBeVisible();
    await expect(page.getByText('You left fullscreen mode.')).toBeVisible();
    await page.getByRole('button', { name: 'Return to exam' }).click();
    await expect(page.getByText(`Warning ${count} of 2`)).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => Boolean(document.fullscreenElement))).toBe(true);
  }

  // The third time ends the exam, after the server has recorded it.
  const terminated = page.waitForResponse(r => r.url().includes('/rest/v1/rpc/terminate_exam'));
  await leaveFullscreen(page);
  await terminated;
  await expect(page.getByRole('heading', { name: 'Exam Terminated' })).toBeVisible();
  await expect(page.getByText('You left fullscreen mode after the final warning.')).toBeVisible();
  await expect(page.getByRole('button', { name: /Log out/ })).toBeVisible();
  expect(await page.evaluate(() => Boolean(document.fullscreenElement))).toBe(false);

  await page.getByRole('button', { name: /Return to Dashboard/ }).click();
  await expect(page.getByText('Your Assigned Examinations')).toBeVisible();
  await expect(card.getByText('Completed')).toBeVisible();
  await expect(card.getByRole('button', { name: /Start Exam|Resume Exam/ })).toHaveCount(0);

  // A reload must not bring the exam back.
  await page.reload();
  await expect(page.getByText('Your Assigned Examinations')).toBeVisible();
  await expect(page.locator('.active-exam-content')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Submit Exam' })).toHaveCount(0);
  await expect(card.getByRole('button', { name: /Start Exam|Resume Exam/ })).toHaveCount(0);
});
