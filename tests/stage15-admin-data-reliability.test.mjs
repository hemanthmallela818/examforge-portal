import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createLatestRequestTracker, runWithDeadline } from '../src/adminDataReliability.js';
import { adminSourceSync } from './support/adminSource.mjs';

const dashboard = adminSourceSync();
const operationsView = readFileSync(resolve('src/components/AdminOperationsView.jsx'), 'utf8');
const databaseCleanerView = readFileSync(resolve('src/components/AdminDatabaseCleanerView.jsx'), 'utf8');
const app = readFileSync(resolve('src/App.jsx'), 'utf8');

test('administrator verification distinguishes network failure from denied access and can retry', () => {
  assert.match(dashboard, /if \(userError\) throw userError/);
  assert.match(dashboard, /if \(error\) throw error;[\s\S]*?if \(role !== 'admin'\)/);
  assert.match(dashboard, /setAdminAccess\('ERROR'\)/);
  assert.match(dashboard, /Retry verification/);
  assert.match(dashboard, /role=\{adminAccess === 'ERROR' \? 'alert' : 'status'\}/);
});

test('administrator data loaders preserve old state, expose failures, and support retry', () => {
  for (const key of ['counts', 'exams', 'examDetail', 'results', 'students', 'questions', 'classes']) {
    assert.match(dashboard, new RegExp(`runAdminDataLoad\\('${key}'`));
  }
  assert.match(dashboard, /Some administrator data could not be refreshed/);
  assert.match(dashboard, /Retry failed data/);
  assert.match(dashboard, /Existing entries may be stale|stale or incomplete/);
  assert.match(dashboard, /Wait for a complete, valid result list before exporting/);
  assert.match(databaseCleanerView, /Storage capacity and remaining quota depend on the configured Supabase plan/);
  assert.doesNotMatch(`${dashboard}\n${databaseCleanerView}`, /freeTierLimit|\/ 500 MB/);
  assert.match(databaseCleanerView, /tableCounts\[table\.key\] === null \? 'Not loaded'/);
});

test('overlapping refreshes are latest-request-wins and unmounted pages ignore completion', () => {
  const tracker = createLatestRequestTracker();
  const first = tracker.begin('students');
  const second = tracker.begin('students');
  const otherCollection = tracker.begin('classes');
  assert.equal(tracker.isCurrent('students', first), false);
  assert.equal(tracker.isCurrent('students', second), true);
  assert.equal(tracker.isCurrent('classes', otherCollection), true);
  tracker.deactivate();
  assert.equal(tracker.isCurrent('students', second), false);
  tracker.activate();
  assert.equal(tracker.isCurrent('students', second), true);

  assert.match(dashboard, /dataLoadTracker\.current\.isCurrent\(key, generation\)/);
  assert.match(dashboard, /if \(!result\.ok \|\| !result\.current\) return result\.ok/);
});

test('Question Bank filters and pagination always trigger a fresh server query', () => {
  assert.match(
    dashboard,
    /activeTab === 'QUESTION_BANK' \|\| activeTab === 'AI_IMPORTER'[\s\S]*?\n\s*fetchQuestionBank\(\);/,
    'the owning screen effect must fetch after a Question Bank query changes'
  );
  assert.doesNotMatch(
    dashboard,
    /if \(!loadedCollections\.current\.has\('questions'\)\) fetchQuestionBank\(\);/,
    'a load-once guard must not suppress later Question Bank filters or pages'
  );
});

test('administrator data requests have a bounded deadline', async () => {
  await assert.rejects(
    runWithDeadline(() => new Promise(() => {}), 10),
    /timed out/i
  );
  assert.equal(await runWithDeadline(async () => 'loaded', 50), 'loaded');
  assert.match(dashboard, /runWithDeadline\(work\)/);
});

test('operations and audit rendering is isolated from the dashboard controller', () => {
  assert.match(dashboard, /import AdminOperationsView from '\.\/AdminOperationsView'/);
  assert.match(dashboard, /<AdminOperationsView[\s\S]*?onRefresh=\{fetchOperationalOverview\}/);
  assert.doesNotMatch(dashboard, /const renderOperationsView/);
  assert.match(operationsView, /Operational Health/);
  assert.match(operationsView, /Storage Assets & Cleanup/);
  assert.match(operationsView, /Recent Administrator Audit Trail/);
});

test('database maintenance rendering is isolated from the dashboard controller', () => {
  assert.match(dashboard, /import AdminDatabaseCleanerView from '\.\/AdminDatabaseCleanerView'/);
  assert.match(dashboard, /<AdminDatabaseCleanerView[\s\S]*?onMaintainTable=\{handleClearTable\}/);
  assert.doesNotMatch(dashboard, /const renderDbCleanerView/);
  assert.match(databaseCleanerView, /Supabase Database Storage/);
  assert.match(databaseCleanerView, /Finalize Expired Attempts/);
  assert.match(databaseCleanerView, /Clear Question Bank/);
  assert.match(databaseCleanerView, /disabled=\{table\.protected \|\| \(table\.rootOnly && !isRootDeveloper\)\}/);
});

test('student duplicate lookup fails closed and administrator callback is stable', () => {
  assert.match(dashboard, /error: duplicateCheckError/);
  assert.match(dashboard, /if \(duplicateCheckError\) throw duplicateCheckError/);
  assert.match(app, /handleAdminBackToLogin = useCallback/);
  assert.match(app, /<AdminDashboard onBackToLogin=\{handleAdminBackToLogin\}/);
  assert.doesNotMatch(app, /<AdminDashboard onBackToLogin=\{\(\) =>/);
});
