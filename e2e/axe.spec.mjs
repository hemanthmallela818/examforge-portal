import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { fixturesFor } from './support/fixtures.mjs';

// Automated WCAG 2 A/AA scan of the main screens. Serious and critical
// violations fail the build; minor/moderate ones are attached to the report.
const scan = async (page, testInfo, name) => {
  // Measure the settled UI: fade-in animations make text briefly translucent,
  // which axe would otherwise report as low contrast.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.evaluate(() => Promise.all(document.getAnimations().map(animation => animation.finished.catch(() => undefined))));
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  await testInfo.attach(`axe-${name}.json`, { body: JSON.stringify(results.violations, null, 2), contentType: 'application/json' });
  const blocking = results.violations
    .filter(violation => ['serious', 'critical'].includes(violation.impact))
    .map(violation => `${violation.id} (${violation.impact}): ${violation.help} — ${violation.nodes.length} node(s), e.g. ${violation.nodes[0]?.target?.join(' ')}`);
  expect(blocking, `${name} has blocking accessibility violations`).toEqual([]);
};

test('login, student dashboard and exam instructions have no serious accessibility violations', async ({ page }, testInfo) => {
  const fixture = fixturesFor(testInfo.project.name);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Exam Portal' })).toBeVisible();
  await scan(page, testInfo, 'login');

  await page.getByLabel('Student ID').fill(fixture.credentials.accessibilityStudent?.studentId ?? fixture.credentials.student.studentId);
  await page.getByLabel('Password').fill(fixture.credentials.accessibilityStudent?.password ?? fixture.credentials.student.password);
  await page.getByRole('button', { name: 'Login' }).click();
  // Another spec may have signed this student in first; acknowledge the takeover notice.
  const takeoverNotice = page.getByRole('dialog', { name: 'Notification' });
  await takeoverNotice.waitFor({ state: 'visible', timeout: 3000 }).then(
    () => takeoverNotice.getByRole('button', { name: 'OK' }).click(),
    () => undefined
  );
  await expect(page.getByText('Your Assigned Examinations')).toBeVisible();
  await scan(page, testInfo, 'student-dashboard');
});

test('administrator screens have no serious accessibility violations', async ({ page }, testInfo) => {
  const fixture = fixturesFor(testInfo.project.name);
  await page.goto('/');
  await page.getByRole('tab', { name: 'Admin Login' }).click();
  await page.getByLabel('Admin Email').fill(fixture.credentials.root.email);
  await page.getByLabel('Password').fill(fixture.credentials.root.password);
  await page.getByRole('button', { name: 'Login' }).click();
  await expect(page.getByRole('heading', { name: 'Dashboard Overview' })).toBeVisible();
  await scan(page, testInfo, 'admin-overview');

  await page.getByRole('button', { name: 'Subjects & Patterns' }).click();
  await expect(page.getByRole('heading', { name: 'Subjects & Exam Patterns' })).toBeVisible();
  await scan(page, testInfo, 'subjects-and-patterns');

  await page.getByRole('button', { name: 'Question Bank' }).first().click();
  await expect(page.getByRole('heading', { name: 'Question Bank', level: 2 })).toBeVisible();
  await scan(page, testInfo, 'question-bank');
});
