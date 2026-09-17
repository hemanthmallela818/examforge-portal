import { test, expect } from '@playwright/test';
import { fixturesFor } from './support/fixtures.mjs';

const loginStudent = async (page, student) => {
  await page.goto('/');
  await page.getByLabel('Student ID').fill(student.studentId);
  await page.getByLabel('Password').fill(student.password);
  await page.getByRole('button', { name: 'Login' }).click();
  await expect(page.getByText('Your Assigned Examinations')).toBeVisible();
};

const expectNoHorizontalOverflow = async page => {
  await expect.poll(() => page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    content: document.documentElement.scrollWidth
  }))).toEqual(expect.objectContaining({
    content: expect.any(Number),
    viewport: expect.any(Number)
  }));
  const dimensions = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    content: document.documentElement.scrollWidth
  }));
  expect(dimensions.content).toBeLessThanOrEqual(dimensions.viewport + 1);
};

test('MFA setup traps keyboard focus and restores it when cancelled', async ({ page }, testInfo) => {
  const fixture = fixturesFor(testInfo.project.name);
  await page.goto('/');
  await page.getByRole('tab', { name: 'Admin Login' }).click();
  await page.getByLabel('Admin Email').fill(fixture.credentials.accessibilityAdmin.email);
  await page.getByLabel('Password').fill(fixture.credentials.accessibilityAdmin.password);
  const loginButton = page.getByRole('button', { name: 'Login' });
  await loginButton.click();

  const dialog = page.getByRole('dialog', { name: 'Setup Two-Factor Authentication' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel(/confirmation code/i)).toBeFocused();
  const lastControl = dialog.getByRole('button', { name: 'Lost your authenticator device?' });
  await lastControl.focus();
  await page.keyboard.press('Tab');
  await expect(dialog.getByRole('button', { name: 'Copy secret key' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(loginButton).toBeFocused();
});

test('exam UI announces saves, respects accessibility media, and keeps modal focus contained', async ({ page }, testInfo) => {
  const fixture = fixturesFor(testInfo.project.name);
  await page.emulateMedia({ reducedMotion: 'reduce', forcedColors: 'active' });
  await loginStudent(page, fixture.credentials.accessibilityStudent);

  await page.setViewportSize({ width: 640, height: 720 });
  await expectNoHorizontalOverflow(page);
  const examCard = page.locator('.student-exam-card').filter({ hasText: fixture.exam.title });
  await examCard.getByRole('button', { name: /Start Exam/ }).click();
  await expect(page.getByText('Mobile Device Detected')).toBeVisible();
  await expectNoHorizontalOverflow(page);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByLabel('I have read and understood the instructions.').check();
  await page.getByRole('button', { name: 'Start Exam', exact: true }).click();
  await expect(page.getByRole('heading', { name: fixture.exam.title })).toBeVisible();
  await expectNoHorizontalOverflow(page);

  const reducedAnimationDuration = await page.evaluate(() => {
    const probe = document.createElement('div');
    probe.style.animationName = 'accessibility-probe';
    probe.style.animationDuration = '2s';
    document.body.appendChild(probe);
    const duration = getComputedStyle(probe).animationDuration;
    probe.remove();
    return duration;
  });
  const reducedAnimationMs = reducedAnimationDuration.endsWith('ms')
    ? Number.parseFloat(reducedAnimationDuration)
    : Number.parseFloat(reducedAnimationDuration) * 1000;
  expect(reducedAnimationMs).toBeCloseTo(0.01, 5);

  await page.getByRole('radio', { name: /B\.\s*Second/ }).check();
  await page.getByRole('button', { name: /Save & Next/ }).click();
  await expect(page.locator('#sr-polite-announcer')).toContainText('Response saved to server.');
  const answeredStatus = page.locator('.status-answered').first();
  expect(await answeredStatus.evaluate(element => getComputedStyle(element).borderStyle)).toBe('solid');

  const submitButton = page.getByRole('button', { name: 'Submit Exam' });
  await submitButton.click();
  const submitDialog = page.getByRole('dialog', { name: 'Submit Exam?' });
  const cancelButton = submitDialog.getByRole('button', { name: 'Cancel' });
  const confirmButton = submitDialog.getByRole('button', { name: 'Yes, Submit' });
  await expect(cancelButton).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(confirmButton).toBeFocused();
  // Fullscreen browsers reserve the first Escape press to leave fullscreen,
  // which intentionally triggers the exam proctoring warning. Exercise the
  // dialog's explicit close action here; the MFA test covers Escape dismissal.
  await cancelButton.click();
  await expect(submitDialog).toHaveCount(0);
  await expect(submitButton).toBeFocused();
});
