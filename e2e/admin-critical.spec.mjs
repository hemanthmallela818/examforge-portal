import { test, expect } from '@playwright/test';
import { fixturesFor, generateTotp } from './support/fixtures.mjs';

const acknowledge = async (page, title = 'Notification') => {
  const dialog = page.getByRole('dialog', { name: title });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: title === 'Confirmation Required' ? 'Confirm' : 'OK' }).click();
};

const loginAal2Administrator = async (page, account) => {
  await page.goto('/');
  await page.getByRole('tab', { name: 'Admin Login' }).click();
  await page.getByLabel('Admin Email').fill(account.email);
  await page.getByLabel('Password').fill(account.password);
  await page.getByRole('button', { name: 'Login' }).click();

  const setupDialog = page.getByRole('dialog', { name: 'Setup Two-Factor Authentication' });
  await expect(setupDialog).toBeVisible();
  const secret = (await setupDialog.locator('code').innerText()).trim();
  await setupDialog.getByLabel(/confirmation code/i).fill(generateTotp(secret));
  await setupDialog.getByRole('button', { name: 'Activate & Continue' }).click();
  await expect(page.getByRole('heading', { name: 'Dashboard Overview' })).toBeVisible();
};

const openExamDetail = async (page, title) => {
  await page.getByRole('button', { name: /Dashboard/ }).click();
  const search = page.getByLabel('Search examinations by title, class, or section');
  await search.fill(title);
  await page.getByRole('region', { name: 'Filter examinations' }).getByRole('button', { name: 'Search', exact: true }).click();
  const card = page.locator('.admin-exam-card').filter({ hasText: title });
  await expect(card).toBeVisible();
  await card.getByRole('button', { name: /Manage/ }).click();
  await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
};

test('administrator imports reviewed JSON, assembles an exam, and enforces lifecycle transitions', async ({ page }, testInfo) => {
  const fixture = fixturesFor(testInfo.project.name);
  await loginAal2Administrator(page, fixture.credentials.operationsAdmin);

  await page.getByRole('button', { name: /Operations & Audit/ }).click();
  await expect(page.getByRole('heading', { name: 'Operational Health' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Storage Assets & Cleanup' })).toBeVisible();

  await page.getByRole('button', { name: /Database Cleaner/ }).click();
  await expect(page.getByRole('heading', { name: 'Database Maintenance & Cleaner' })).toBeVisible();
  await expect(page.getByRole('heading', { name: /Supabase Database Storage/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /Finalize Expired Attempts/ })).toBeEnabled();
  const protectedMaintenanceActions = page.getByRole('button', { name: /Protected Record/ });
  await expect(protectedMaintenanceActions).toHaveCount(5);
  for (let index = 0; index < 5; index += 1) await expect(protectedMaintenanceActions.nth(index)).toBeDisabled();

  await page.getByRole('button', { name: /Reviewed JSON Import/ }).click();
  await expect(page.getByRole('heading', { name: 'Reviewed JSON Import' }).first()).toBeVisible();

  const unique = Date.now();
  const texts = {
    Physics: `E2E imported Physics question ${unique}`,
    Chemistry: `E2E imported Chemistry question ${unique}`,
    Mathematics: `E2E imported Mathematics question ${unique}`
  };
  const questions = Object.entries(texts).map(([subject, questionText], index) => ({
    id: `e2e-admin-${unique}-${index + 1}`,
    question_number: index + 1,
    question_text: questionText,
    question_type: 'MCQ',
    options: [
      { label: 'A', text: 'One' },
      { label: 'B', text: 'Two' },
      { label: 'C', text: 'Three' },
      { label: 'D', text: 'Four' }
    ],
    correct_answer: 'B',
    subject,
    has_image_or_diagram: false
  }));

  await page.locator('input[type="file"]').setInputFiles({
    name: `reviewed-admin-${unique}.json`,
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify({ version: '1.0', questions }))
  });
  await expect(page.getByRole('heading', { name: /Review Questions \(3 total\)/ })).toBeVisible();
  await page.getByRole('button', { name: 'Approve All Valid' }).click();
  await page.getByRole('button', { name: '📥 Import Approved (3)' }).click();
  await acknowledge(page, 'Confirmation Required');
  const importResult = page.getByRole('dialog', { name: 'Notification' });
  await expect(importResult).toContainText('Successfully imported: 3');
  await importResult.getByRole('button', { name: 'OK' }).click();

  await page.getByRole('button', { name: /Question Bank/ }).click();
  await page.getByLabel('Search questions by number, text, or subject').fill(String(unique));
  await page.getByRole('main').getByRole('button', { name: 'Search', exact: true }).click();
  await expect(page.getByText('Loading requested Question Bank page…')).toHaveCount(0, { timeout: 30_000 });
  for (const text of Object.values(texts)) {
    await expect(page.getByText(text, { exact: true })).toBeVisible();
  }
  const matchingQuestionCheckboxes = page.getByRole('checkbox', { name: new RegExp(`Select question .*${unique}`) });
  await expect(matchingQuestionCheckboxes).toHaveCount(3);
  for (let index = 0; index < 3; index += 1) {
    const checkbox = matchingQuestionCheckboxes.nth(index);
    await checkbox.click();
    await expect(checkbox).toBeChecked();
  }

  const examTitle = `E2E Admin Lifecycle ${unique}`;
  await page.getByPlaceholder('Exam Title (e.g. Midterms)').fill(examTitle);
  await page.getByLabel('Target class for new exam').selectOption(fixture.className);
  await page.getByLabel('Target section for new exam').selectOption(fixture.section);
  await page.getByRole('button', { name: 'Create Exam', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Dashboard Overview' })).toBeVisible();

  await openExamDetail(page, examTitle);
  await expect(page.getByText('PENDING', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: /Start Exam/ }).click();
  const preflight = page.getByRole('dialog', { name: 'Notification' });
  await expect(preflight).toContainText('Preflight Check Passed');
  await preflight.getByRole('button', { name: 'OK' }).click();
  await expect(page.getByText('ACTIVE', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: /End Exam/ }).click();
  await acknowledge(page, 'Confirmation Required');
  await expect(page.getByText('ENDED', { exact: true })).toBeVisible();
});

test('administrator downloads complete audited CSV and PDF result exports', async ({ page }, testInfo) => {
  const fixture = fixturesFor(testInfo.project.name);
  await loginAal2Administrator(page, fixture.credentials.exportAdmin);
  await openExamDetail(page, fixture.reportExam.title);

  const csvDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: /Download CSV/ }).click();
  expect((await csvDownload).suggestedFilename()).toMatch(/\.csv$/i);

  const pdfDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: /Download PDF/ }).click();
  expect((await pdfDownload).suggestedFilename()).toMatch(/\.pdf$/i);
});
