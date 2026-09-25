import { test, expect } from '@playwright/test';
import { fixturesFor } from './support/fixtures.mjs';

// Phone, tablet and small-laptop layouts (U14). Viewport-only emulation keeps
// the spec valid for every configured browser project (Firefox has no
// isMobile support), while matching the Pixel 7 / iPad Mini / 1024px widths.
const VIEWPORTS = [
  { name: 'small phone (360px)', viewport: { width: 360, height: 740 } },
  { name: 'Pixel 7 (412px)', viewport: { width: 412, height: 915 } },
  { name: 'iPad Mini portrait (768px)', viewport: { width: 768, height: 1024 } },
  { name: 'small laptop (1024px)', viewport: { width: 1024, height: 768 } }
];

const MIN_TOUCH_TARGET = 44;

const expectNoHorizontalOverflow = async (page) => {
  const dimensions = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    content: document.documentElement.scrollWidth
  }));
  expect(dimensions.content, 'page must not scroll horizontally').toBeLessThanOrEqual(dimensions.viewport + 1);
};

const expectUsable = async (locator, { touch = false } = {}) => {
  await expect(locator).toBeVisible();
  await locator.scrollIntoViewIfNeeded();
  await expect(locator).toBeInViewport();
  const box = await locator.boundingBox();
  const viewportWidth = await locator.page().evaluate(() => document.documentElement.clientWidth);
  expect(box).not.toBeNull();
  expect(box.x).toBeGreaterThanOrEqual(-1);
  expect(box.x + box.width).toBeLessThanOrEqual(viewportWidth + 1);
  if (touch) expect(box.height).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET - 0.5);
};

const acknowledgeTakeoverNotice = async (page) => {
  const notice = page.getByRole('dialog', { name: 'Notification' });
  if (await notice.isVisible().catch(() => false)) {
    await notice.getByRole('button', { name: 'OK' }).click();
  }
};

const loginStudent = async (page, student) => {
  await page.goto('/');
  await page.getByLabel('Student ID').fill(student.studentId);
  await page.getByLabel('Password').fill(student.password);
  await page.getByRole('button', { name: 'Login' }).click();
  const heading = page.getByText('Your Assigned Examinations');
  await expect(heading.or(page.getByRole('dialog', { name: 'Notification' })).first()).toBeVisible();
  await acknowledgeTakeoverNotice(page);
  await expect(heading).toBeVisible();
};

for (const { name, viewport } of VIEWPORTS) {
  test.describe(`responsive layout: ${name}`, () => {
    test.use({ viewport, hasTouch: viewport.width < 1024 });

    test('login page fits the screen and its controls are usable', async ({ page }) => {
      await page.goto('/');
      await expect(page.getByLabel('Student ID')).toBeVisible();
      await expectNoHorizontalOverflow(page);
      await expectUsable(page.getByLabel('Student ID'));
      await expectUsable(page.getByLabel('Password'));
      await expectUsable(page.getByRole('button', { name: 'Login' }), { touch: viewport.width < 1024 });
      await expectUsable(page.getByRole('tab', { name: 'Admin Login' }));
    });

    test('student dashboard groups exams without horizontal scrolling', async ({ page }, testInfo) => {
      const fixture = fixturesFor(testInfo.project.name);
      await loginStudent(page, fixture.credentials.student);
      await acknowledgeTakeoverNotice(page);

      await expect(page.locator('.student-exam-card').first()).toBeVisible();
      await expectNoHorizontalOverflow(page);
      await expectUsable(page.getByRole('button', { name: 'Logout' }), { touch: viewport.width < 1024 });

      const examCard = page.locator('.student-exam-card').filter({ hasText: fixture.exam.title });
      await expect(examCard).toBeVisible();
      // The shared fixture exam is Live before the exam spec runs and
      // Completed after it; either way its primary action must be reachable.
      const action = examCard.getByRole('button', { name: /Start Exam|Resume Exam|View Scorecard/ });
      await expectUsable(action, { touch: viewport.width < 1024 });

      // Every rendered exam group has a heading, and each card stays inside the viewport.
      const groups = page.getByRole('region').filter({ has: page.locator('.student-exam-card') });
      expect(await groups.count()).toBeGreaterThan(0);
      for (const card of await page.locator('.student-exam-card').all()) {
        const box = await card.boundingBox();
        expect(box).not.toBeNull();
        expect(box.x + box.width).toBeLessThanOrEqual(viewport.width + 1);
      }
      await expectNoHorizontalOverflow(page);

      // Sign out so later specs that use the same student start without a
      // "replaced another active device" notice.
      await page.getByRole('button', { name: 'Logout' }).click();
      await expect(page.getByLabel('Student ID')).toBeVisible();
    });
  });
}
