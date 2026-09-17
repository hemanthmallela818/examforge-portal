import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

test('administrator analytics are loaded only when the exam detail needs charts', () => {
  const dashboard = readFileSync(resolve('src/components/AdminDashboard.jsx'), 'utf8');
  const charts = readFileSync(resolve('src/components/AdminAnalyticsCharts.jsx'), 'utf8');

  assert.doesNotMatch(dashboard, /from ['"]recharts['"]/, 'Main administrator chunk must not statically import Recharts');
  assert.match(dashboard, /React\.lazy\(\(\) => import\(['"]\.\/AdminAnalyticsCharts['"]\)\)/);
  assert.match(dashboard, /<React\.Suspense[\s\S]*?<AdminAnalyticsCharts/);
  assert.match(charts, /from ['"]recharts['"]/, 'Lazy analytics chunk must own the chart dependency');
});

test('import history is explicitly bounded and load failures are visible', () => {
  const importer = readFileSync(resolve('src/components/AIQuestionImporter.jsx'), 'utf8');
  assert.match(importer, /\.from\(['"]import_history['"]\)[\s\S]*?\.limit\(100\)/);
  assert.match(importer, /setHistoryError\(['"]Import history could not be loaded/);
  assert.match(importer, /role="alert"/);
  assert.match(importer, /latest 100 import batches/i);
});
