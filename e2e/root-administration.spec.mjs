import { test, expect } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import { fixturesFor } from './support/fixtures.mjs';

test('only the root developer can create and disable administrators', async ({ page }, testInfo) => {
  const fixture = fixturesFor(testInfo.project.name);
  const suffix = `${testInfo.project.name}-${Date.now()}`;
  const email = `managed-${suffix}@e2e.local`;
  const password = 'Managed-Admin!2026';

  await page.goto('/');
  await page.getByRole('tab', { name: 'Admin Login' }).click();
  await page.getByLabel('Admin Email').fill(fixture.credentials.root.email);
  await page.getByLabel('Password').fill(fixture.credentials.root.password);
  await page.getByRole('button', { name: 'Login' }).click();
  await expect(page.getByRole('heading', { name: 'Dashboard Overview' })).toBeVisible();

  await page.getByText('Root developer — Manage administrators').click();
  await page.getByLabel('Name').fill(`Managed ${testInfo.project.name} Administrator`);
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Create administrator' }).click();
  await expect(page.locator('details p[role="status"]')).toContainText('Administrator created');

  const managedRow = page.getByRole('listitem').filter({ hasText: email });
  await expect(managedRow).toContainText('Enabled');

  const managedClient = createClient(fixture.local.url, fixture.local.anonKey, {
    auth: { persistSession: false, autoRefreshToken: false }
  });
  const { error: loginError } = await managedClient.auth.signInWithPassword({ email, password });
  expect(loginError).toBeNull();
  expect((await managedClient.rpc('is_admin_aal2')).data).toBe(true);

  await managedRow.getByRole('button', { name: 'Disable' }).click();
  await expect(managedRow).toContainText('Disabled');
  expect((await managedClient.rpc('is_admin_aal2')).data).toBe(false);
});
