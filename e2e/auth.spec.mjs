import { test, expect } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import { fixturesFor } from './support/fixtures.mjs';

test('student signs in with an assigned account and signs out', async ({ page }, testInfo) => {
  const { credentials } = fixturesFor(testInfo.project.name);
  await page.goto('/');
  await page.getByLabel('Student ID').fill(credentials.authStudent.studentId);
  await page.getByLabel('Password').fill(credentials.authStudent.password);
  await page.getByRole('button', { name: 'Login' }).click();

  await expect(page.getByRole('heading', { name: `E2E ${testInfo.project.name} Authentication Student` })).toBeVisible();
  await expect(page.getByText('Your Assigned Examinations')).toBeVisible();
  await page.getByRole('button', { name: 'Logout' }).click();
  await expect(page.getByRole('heading', { name: 'Exam Portal' })).toBeVisible();
});

test('public email sign-up remains disabled while email/password login is enabled', async ({ browserName }) => {
  const fixture = fixturesFor(browserName);
  const client = createClient(fixture.local.url, fixture.local.anonKey, {
    auth: { persistSession: false, autoRefreshToken: false }
  });
  const { data, error } = await client.auth.signUp({
    email: `forbidden-${browserName}@e2e.local`,
    password: 'Forbidden!2026'
  });
  expect(data.user).toBeNull();
  expect(error?.message).toMatch(/signups not allowed|signup.*disabled/i);
});

test('approved administrator signs in with a password and the session survives reload', async ({ page }, testInfo) => {
  const { credentials } = fixturesFor(testInfo.project.name);
  await page.goto('/');
  await page.getByRole('tab', { name: 'Admin Login' }).click();
  await page.getByLabel('Admin Email').fill(credentials.admin.email);
  await page.getByLabel('Password').fill(credentials.admin.password);
  await page.getByRole('button', { name: 'Login' }).click();

  await expect(page.getByText('Dashboard Overview')).toBeVisible();
  await expect(page.getByText('Administrator', { exact: true })).toBeVisible();
  await expect(page.getByRole('dialog', { name: /Two-Factor Authentication/i })).toHaveCount(0);

  await page.reload();
  await expect(page.getByText('Dashboard Overview')).toBeVisible();
});
