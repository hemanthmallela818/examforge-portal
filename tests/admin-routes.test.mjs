import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  ADMIN_TAB_PATHS,
  formatAdminPath,
  isAdminPath,
  normalizeAdminRoute,
  parseAdminPath,
  resolveInitialAdminRoute
} from '../src/features/admin/routing/adminRoutes.js';
import { adminSource, adminSourceFiles } from './support/adminSource.mjs';

test('every admin tab has a stable URL that round-trips', () => {
  assert.deepEqual(ADMIN_TAB_PATHS, {
    DASHBOARD: '/admin',
    STUDENTS: '/admin/students',
    CLASSES: '/admin/classes',
    SUBJECTS: '/admin/subjects',
    QUESTION_BANK: '/admin/questions',
    AI_IMPORTER: '/admin/import',
    OPERATIONS: '/admin/operations',
    DB_CLEANER: '/admin/database',
    SETTINGS: '/admin/settings'
  });
  for (const [tab, path] of Object.entries(ADMIN_TAB_PATHS)) {
    assert.deepEqual(parseAdminPath(path), { tab, examId: null });
    assert.equal(formatAdminPath({ tab, examId: null }), path);
  }
  assert.deepEqual(parseAdminPath('/admin/students/'), { tab: 'STUDENTS', examId: null });
});

test('exam detail URLs carry the exam id and reject malformed ids', () => {
  const id = '3f1c2b9a-0d4e-4a51-9b7e-1c2d3e4f5a6b';
  assert.equal(formatAdminPath({ tab: 'DASHBOARD', examId: id }), `/admin/exams/${id}`);
  assert.deepEqual(parseAdminPath(`/admin/exams/${id}`), { tab: 'DASHBOARD', examId: id });
  assert.equal(parseAdminPath('/admin/exams/'), null);
  assert.equal(parseAdminPath('/admin/exams/a%2Fb'), null);
  assert.equal(parseAdminPath('/admin/exams/%E0%A4%A'), null);
  assert.equal(parseAdminPath('/admin/exams/x/y'), null);
  assert.deepEqual(normalizeAdminRoute({ tab: 'STUDENTS', examId: id }), { tab: 'STUDENTS', examId: null });
  assert.deepEqual(normalizeAdminRoute({ tab: 'NOPE' }), { tab: 'DASHBOARD', examId: null });
});

test('only /admin paths belong to the admin shell', () => {
  assert.equal(isAdminPath('/admin'), true);
  assert.equal(isAdminPath('/admin/questions'), true);
  assert.equal(isAdminPath('/'), false);
  assert.equal(isAdminPath('/dashboard'), false);
  assert.equal(isAdminPath('/administrator'), false);
  assert.equal(parseAdminPath('/exam'), null);
  assert.equal(parseAdminPath('/admin/unknown'), null);
});

test('reloads and deep links restore the tab even after App.jsx rewrites the URL to /admin', () => {
  // App.jsx pushes '/' and then '/admin' before the shell mounts.
  assert.deepEqual(resolveInitialAdminRoute('/admin', '/admin/students'), { tab: 'STUDENTS', examId: null });
  assert.deepEqual(resolveInitialAdminRoute('/admin', '/admin/exams/abc-123'), { tab: 'DASHBOARD', examId: 'abc-123' });
  // An explicit sub-route in the current URL wins over the document URL.
  assert.deepEqual(resolveInitialAdminRoute('/admin/classes', '/admin/students'), { tab: 'CLASSES', examId: null });
  // Fresh sign-in, or the deep link was already used: the Dashboard.
  assert.deepEqual(resolveInitialAdminRoute('/admin', '/'), { tab: 'DASHBOARD', examId: null });
  assert.deepEqual(resolveInitialAdminRoute('/admin', null), { tab: 'DASHBOARD', examId: null });
  assert.deepEqual(resolveInitialAdminRoute('/admin', '/admin/unknown'), { tab: 'DASHBOARD', examId: null });
});

test('the admin shell uses the History API and never pushes a non-admin path', async () => {
  const source = await adminSource();
  assert.match(source, /window\.history\.pushState\(state, '', path\)/);
  assert.match(source, /addEventListener\('popstate', handlePopState\)/);
  assert.match(source, /if \(!isAdminPath\(pathname\)\) return;/);
  assert.doesNotMatch(source, /pushState\([^)]*'\/(?:dashboard|exam)?'\)/);
});

test('the admin source helper covers the shell and every feature module', async () => {
  const files = await adminSourceFiles();
  assert.equal(files[0], 'src/components/AdminDashboard.jsx');
  assert.ok(files.includes('src/features/admin/AdminShell.jsx'));
  assert.ok(files.includes('src/features/admin/exams/ExamDetailView.jsx'));
  assert.ok(files.every(path => /\.(?:js|jsx)$/.test(path)));
});

test('Vercel serves the SPA for deep links without rewriting built assets', () => {
  const config = JSON.parse(readFileSync(resolve('vercel.json'), 'utf8'));
  assert.deepEqual(config.rewrites, [{ source: '/((?!assets/).*)', destination: '/index.html' }]);
  const pattern = new RegExp(`^${config.rewrites[0].source}$`);
  assert.equal(pattern.test('/admin/students'), true);
  assert.equal(pattern.test('/admin/exams/abc'), true);
  assert.equal(pattern.test('/assets/index-abc123.js'), false);
});
