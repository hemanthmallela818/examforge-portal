import test from 'node:test';
import assert from 'node:assert/strict';
import { validateRuntimeConfiguration } from '../src/runtimeConfig.js';
import { redactDiagnosticText, safeErrorDetails } from '../src/runtimeDiagnostics.js';

test('runtime configuration rejects missing, placeholder and insecure production values', () => {
  assert.equal(validateRuntimeConfiguration('', '').valid, false);
  assert.equal(validateRuntimeConfiguration('https://YOUR_PROJECT.supabase.co', 'YOUR_PUBLIC_ANON_KEY').valid, false);
  assert.equal(validateRuntimeConfiguration('http://project.supabase.co', 'a'.repeat(30)).valid, false);
  assert.equal(validateRuntimeConfiguration('http://localhost:54321', 'a'.repeat(30)).valid, true);
  assert.equal(validateRuntimeConfiguration('https://project.supabase.co', 'a'.repeat(30)).valid, true);
});

test('client diagnostics redact credentials, tokens and personal email addresses', () => {
  const jwt = `${'a'.repeat(24)}.${'b'.repeat(24)}.${'c'.repeat(16)}`;
  const raw = `user@example.com password=hunter2 https://host/path?access_token=${jwt}&apikey=secret-value`;
  const redacted = redactDiagnosticText(raw);
  assert.doesNotMatch(redacted, /user@example\.com|hunter2|secret-value|aaa/);
  assert.match(redacted, /REDACTED_EMAIL/);
  assert.match(redacted, /REDACTED/);
});

test('safe client error details expose bounded operational context without a stack trace', () => {
  const error = Object.assign(new Error('Failed for admin@example.com'), { code: 'PGRST001', status: 503 });
  const details = safeErrorDetails(error, 'exam.start');
  assert.equal(details.context, 'exam.start');
  assert.equal(details.code, 'PGRST001');
  assert.equal(details.status, 503);
  assert.doesNotMatch(details.message, /admin@example\.com/);
  assert.equal('stack' in details, false);
});
