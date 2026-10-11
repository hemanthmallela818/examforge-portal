import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { nextStudentPollAt, timingFallbackDue, projectUsage, operatingCapacity, isConfirmedSaveReply, responsesForPaper } from './rehearsal-capacity.mjs';
import { dirname, resolve } from 'node:path';
import { createClient } from '@supabase/supabase-js';
import { isTransientRpcError, retryDelayMs } from '../src/examLogic.js';

const url = process.env.REHEARSAL_SUPABASE_URL;
const anonKey = process.env.REHEARSAL_SUPABASE_ANON_KEY;
const serviceKey = process.env.REHEARSAL_SUPABASE_SERVICE_ROLE_KEY;
const adminAccessToken = process.env.REHEARSAL_ADMIN_AAL2_ACCESS_TOKEN;
const expectedProjectRef = process.env.REHEARSAL_EXPECTED_PROJECT_REF;
const destructiveConfirmation = process.env.REHEARSAL_CONFIRM_DISPOSABLE;
const candidateCount = Number.parseInt(process.env.REHEARSAL_CANDIDATE_COUNT || '80', 10);

if (!url || !anonKey || !serviceKey || !adminAccessToken || !expectedProjectRef) {
  throw new Error('Rehearsal URL, anon key, service-role key, AAL2 admin access token, and expected project ref are required.');
}
const rehearsalHost = new URL(url).hostname;
const localTarget = rehearsalHost === '127.0.0.1' || rehearsalHost === 'localhost';
if (localTarget ? expectedProjectRef !== 'local' : rehearsalHost !== `${expectedProjectRef}.supabase.co`) {
  throw new Error(`Refusing to run: target host does not match REHEARSAL_EXPECTED_PROJECT_REF (${expectedProjectRef}).`);
}
if (destructiveConfirmation !== 'YES_RESET_THIS_DISPOSABLE_PROJECT_AFTER_REHEARSAL') {
  throw new Error('Refusing to run without explicit disposable-project reset confirmation.');
}
if (!Number.isInteger(candidateCount) || candidateCount < 1 || candidateCount > 1000) {
  throw new Error('REHEARSAL_CANDIDATE_COUNT must be an integer from 1 through 1000.');
}

// ---------------------------------------------------------------------------
// Load-shape knobs. Every knob has a safe default so the original rehearsal
// command keeps working unchanged. See docs/LOAD_TESTING.md.
// ---------------------------------------------------------------------------
const intEnv = (name, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) => {
  const raw = process.env[name];
  const value = raw === undefined || raw === '' ? fallback : Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer from ${min} through ${max}.`);
  }
  return value;
};
const rangeEnv = (prefix, fallbackMin, fallbackMax, floor) => {
  const min = intEnv(`${prefix}_MIN_MS`, fallbackMin, { min: floor });
  const max = intEnv(`${prefix}_MAX_MS`, Math.max(fallbackMax, min), { min });
  return { min, max };
};

// All candidates act at once by default; a smaller pool models staggered arrival.
const workerConcurrency = intEnv('REHEARSAL_CONCURRENCY', candidateCount, { min: 1, max: 1000 });
const provisionConcurrency = intEnv('REHEARSAL_PROVISION_CONCURRENCY', 4, { min: 1, max: 50 });
const soakSeconds = intEnv('REHEARSAL_SOAK_SECONDS', 60, { min: 0, max: 28_800 });
const fullDurationSeconds = intEnv('REHEARSAL_FULL_DURATION_SECONDS', 0, { min: 0, max: 28_800 });
if (fullDurationSeconds > soakSeconds) throw new Error('SOAK_SECONDS must cover FULL_DURATION_SECONDS.');
const monthlySittings = intEnv('REHEARSAL_MONTHLY_SITTINGS', 1, { min: 1, max: 1000 });
const abandonmentProbes = intEnv('REHEARSAL_ABANDONMENT_PROBES', 0, { min: 0, max: candidateCount });
const mediaFile = process.env.REHEARSAL_MEDIA_FILE;
const mediaRequests = intEnv('REHEARSAL_MEDIA_REQUESTS', 1, { min: 1, max: 500 });
const autosaveInterval = rangeEnv('REHEARSAL_AUTOSAVE', 5_000, 20_000, 1_000);
const studentPollInterval = rangeEnv('REHEARSAL_STUDENT_POLL', 20_000, 30_000, 1_000);
const staleTabPercent = intEnv('REHEARSAL_STALE_TAB_PERCENT', 10, { min: 0, max: 100 });
const takeoverProbeCount = intEnv('REHEARSAL_TAKEOVER_PROBES', Math.min(3, candidateCount), { min: 0, max: candidateCount });
const rushLeadMs = intEnv('REHEARSAL_RUSH_LEAD_MS', 1_000, { min: 0, max: 60_000 });
const realtimeTimeoutMs = intEnv('REHEARSAL_REALTIME_TIMEOUT_MS', 15_000, { min: 1_000, max: 120_000 });
const enforceThresholds = process.env.REHEARSAL_ENFORCE_THRESHOLDS !== '0';

const numberOrThrow = (name, value, min, max) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) throw new Error(`${name} must be a number from ${min} through ${max}.`);
  return parsed;
};
const thresholds = {
  p95Ms: {
    login: 3000,
    claim: 1500,
    realtime_subscribe: 5000,
    dashboard_read: 2000,
    start: 3000,
    autosave: 1000,
    subject_time: 1000,
    final_sync: 1000,
    runtime_read: 2000,
    reconnect_runtime: 2000,
    token_refresh: 3000,
    submit: 3000,
    submit_retry: 3000
  },
  maxErrorRate: 0.01,
  minRealtimeSubscribeRate: 1
};
if (process.env.REHEARSAL_THRESHOLDS) {
  let overrides;
  try { overrides = JSON.parse(process.env.REHEARSAL_THRESHOLDS); } catch {
    throw new Error('REHEARSAL_THRESHOLDS must be JSON, for example {"p95Ms":{"autosave":800},"maxErrorRate":0.02}.');
  }
  for (const [operation, limitMs] of Object.entries(overrides?.p95Ms || {})) {
    thresholds.p95Ms[operation] = numberOrThrow(`REHEARSAL_THRESHOLDS.p95Ms.${operation}`, limitMs, 1, 600_000);
  }
  if (overrides?.maxErrorRate !== undefined) {
    thresholds.maxErrorRate = numberOrThrow('REHEARSAL_THRESHOLDS.maxErrorRate', overrides.maxErrorRate, 0, 1);
  }
  if (overrides?.minRealtimeSubscribeRate !== undefined) {
    thresholds.minRealtimeSubscribeRate = numberOrThrow('REHEARSAL_THRESHOLDS.minRealtimeSubscribeRate', overrides.minRealtimeSubscribeRate, 0, 1);
  }
}
if (process.env.REHEARSAL_MAX_P95_AUTOSAVE_MS) {
  thresholds.p95Ms.autosave = numberOrThrow('REHEARSAL_MAX_P95_AUTOSAVE_MS', process.env.REHEARSAL_MAX_P95_AUTOSAVE_MS, 1, 600_000);
}
if (process.env.REHEARSAL_MAX_ERROR_RATE) {
  thresholds.maxErrorRate = numberOrThrow('REHEARSAL_MAX_ERROR_RATE', process.env.REHEARSAL_MAX_ERROR_RATE, 0, 1);
}
if (process.env.REHEARSAL_MIN_REALTIME_SUBSCRIBE_RATE) {
  thresholds.minRealtimeSubscribeRate = numberOrThrow('REHEARSAL_MIN_REALTIME_SUBSCRIBE_RATE', process.env.REHEARSAL_MIN_REALTIME_SUBSCRIBE_RATE, 0, 1);
}

const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
const adminClient = createClient(url, anonKey, {
  auth: { persistSession: false, autoRefreshToken: false },
  global: { headers: { Authorization: `Bearer ${adminAccessToken}` } }
});
let adminBearer = adminAccessToken;
// Global headers must track the refreshed AAL2 token too.
adminClient.rest.headers.set('Authorization', `Bearer ${adminBearer}`);
adminClient.functions.setAuth(adminBearer);
const prefix = `REHEARSAL-${Date.now()}`;
// logs/ is git-ignored and, unlike test-results/, is not wiped by Playwright.
const reportPath = resolve(process.env.REHEARSAL_REPORT_PATH || `logs/load-rehearsal/${prefix}.json`);
const className = `${prefix}-CLASS`;
const studentPassword = 'Rehearsal!12345';
const students = Array.from({ length: candidateCount }, (_, index) => ({
  studentId: `${prefix}-S${String(index + 1).padStart(3, '0')}`,
  email: `${prefix.toLowerCase()}-s${String(index + 1).padStart(3, '0')}@rehearsal.local`,
  name: `Rehearsal Student ${index + 1}`
}));

// Keep one distinct scoring fingerprint per candidate in larger load runs.
const questionCount = Math.max(80, candidateCount);
const subjects = ['Physics', 'Chemistry', 'Mathematics'];
const rehearsalQuestions = Object.fromEntries(subjects.map(subject => [subject, []]));
for (let index = 0; index < questionCount; index += 1) {
  const subject = subjects[index % subjects.length];
  rehearsalQuestions[subject].push({
    id: `${prefix}-q-${String(index + 1).padStart(3, '0')}`,
    subject,
    type: 'NUMERICAL',
    text: `Rehearsal numerical question ${index + 1}`,
    options: [],
    correctAnswer: String(index + 1),
    hasImageOrDiagram: false
  });
}

const questionsData = {
  subjects,
  // Keep the paper open for the whole soak so autosaves never hit the deadline.
  duration: Math.max(30, Math.ceil(soakSeconds / 60) + 15),
  marksCorrect: 4,
  marksIncorrect: -1,
  questions: rehearsalQuestions
};

const responsesForCandidate = correctTarget => {
  const flattened = [];
  for (let index = 0; index < questionCount; index += 1) {
    const questionId = `${prefix}-q-${String(index + 1).padStart(3, '0')}`;
    const selectedOption = index < correctTarget ? String(index + 1) : String(-(index + 1));
    flattened.push({ question_id: questionId, selected_option: selectedOption, status: 'ANSWERED' });
  }
  return flattened;
};

const limit = async (items, concurrency, task) => {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await task(items[index], index);
    }
  }));
  return results;
};

const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const waitUntil = async timestamp => { if (timestamp > Date.now()) await wait(timestamp - Date.now()); };
const randomBetween = ({ min, max }) => min + Math.floor(Math.random() * (max - min + 1));
const clone = value => JSON.parse(JSON.stringify(value));
const canonical = value => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
};

// Supabase Auth rate-limits password sign-ins by source IP. Keep the
// rehearsal's sign-in starts globally paced even though the rest of the
// candidate workload can remain concurrent. The staging rate-limit setting
// and this delay should be chosen together (for example, 120 sign-ins/5 min
// with a 3000 ms delay). The value is configurable so production-like
// staging environments do not require a code change.
const authSignInDelayMs = Number.parseInt(process.env.REHEARSAL_AUTH_SIGNIN_DELAY_MS || '3000', 10);
if (!Number.isInteger(authSignInDelayMs) || authSignInDelayMs < 0) {
  throw new Error('REHEARSAL_AUTH_SIGNIN_DELAY_MS must be a non-negative integer.');
}
let nextAuthSignInAt = 0;
let authSignInQueue = Promise.resolve();
const waitForAuthSignInSlot = async () => {
  let release;
  const previous = authSignInQueue;
  authSignInQueue = new Promise(resolve => { release = resolve; });
  await previous;
  const remaining = nextAuthSignInAt - Date.now();
  if (remaining > 0) await wait(remaining);
  nextAuthSignInAt = Date.now() + authSignInDelayMs;
  release();
};

const withRetries = async (task, attempts = 5) => {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await task();
    } catch (error) {
      lastError = error;
      const status = Number(error?.status) || 0;
      const serverBusy = status >= 500;
      if ((status !== 429 && !serverBusy) || attempt === attempts - 1) throw error;
      if (serverBusy) {
        // Mirrors AuthPortal.jsx: a momentarily overloaded auth server is
        // retried quickly with full-jitter backoff.
        const ceiling = Math.min(8000, 1500 * (2 ** attempt));
        await wait(ceiling / 2 + Math.random() * (ceiling / 2));
        continue;
      }
      // A 429 is an IP bucket response, so short retries only extend the
      // burst. Back off exponentially and keep the next attempt behind the
      // normal sign-in pacing window.
      await wait(Math.max(authSignInDelayMs, 5000 * (2 ** attempt)));
    }
  }
  throw lastError;
};

const functionErrorSummary = async error => {
  const status = Number(error?.context?.status) || 0;
  let body = '';
  try {
    body = await error?.context?.clone?.().text?.() || '';
  } catch {}
  const boundedBody = body.replace(/[\r\n]+/g, ' ').slice(0, 500);
  return `HTTP ${status || 'unknown'}${boundedBody ? `: ${boundedBody}` : ''}`;
};

// Never let credentials, JWTs, or addresses reach logs or the JSON report.
const redact = value => String(value || '')
  .replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]')
  .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[REDACTED_JWT]')
  .replace(/\bsb_(?:secret|publishable)_[A-Za-z0-9_-]+\b/g, '[REDACTED_KEY]')
  .replace(/(["']?(?:apikey|authorization|token|password)["']?\s*[:=]\s*["'])[^"']+/gi, '$1[REDACTED]')
  .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[REDACTED_EMAIL]')
  .replace(/[\r\n]+/g, ' ')
  .slice(0, 300);

// ---------------------------------------------------------------------------
// Per-operation metrics: latency samples, HTTP status and error breakdown.
// ---------------------------------------------------------------------------
const metrics = new Map();
const operationMetrics = name => {
  if (!metrics.has(name)) {
    metrics.set(name, {
      samples: [], ok: 0, errors: 0, expectedErrors: 0, responseBytes: 0,
      statuses: {}, errorKinds: {}, errorCodes: {}, sampleErrors: [],
      firstStartedAt: Infinity, lastEndedAt: 0
    });
  }
  return metrics.get(name);
};
const increment = (target, key) => { target[key] = (target[key] || 0) + 1; };
const errorKind = (status, error) => {
  const code = String(error?.code || '');
  if (code.startsWith('REALTIME_')) return code.toLowerCase();
  if (code === 'VERSION_CONFLICT') return 'version_conflict';
  if (status === 429) return 'rate_limited_429';
  if (status >= 500) return 'server_5xx';
  if (code === '57014') return 'statement_timeout';
  if (code === '40001' || code === '40P01') return 'serialization_or_deadlock';
  if (code === '53300') return 'too_many_connections';
  if (code.startsWith('PGRST')) return 'postgrest';
  if (status === 0 || /fetch failed|network|ECONNRESET|ETIMEDOUT|socket/i.test(error?.message || '')) return 'network';
  if (code === 'P0001') return 'rpc_exception';
  if (status === 401 || status === 403) return 'auth_denied';
  if (status === 409) return 'conflict_409';
  return status ? `http_${status}` : 'client_error';
};
const recordError = (operation, status, error) => {
  const entry = operationMetrics(operation);
  entry.errors += 1;
  increment(entry.errorKinds, errorKind(status, error));
  if (error?.code) increment(entry.errorCodes, String(error.code));
  const message = redact(error?.message || error);
  if (entry.sampleErrors.length < 5 && !entry.sampleErrors.includes(message)) entry.sampleErrors.push(message);
};

// Runs one client call, records its latency and outcome, and returns a
// Supabase-style { data, error, status } result instead of throwing.
// `expectError` marks designed rejections (for example a stale device) so they
// are not counted as failures; `validate` flags HTTP successes that are
// logically wrong (for example an unexpected version conflict).
const measure = async (operation, task, { bucket, expectError, validate } = {}) => {
  const entry = operationMetrics(operation);
  const startedAt = Date.now();
  const began = performance.now();
  let result;
  let thrown;
  try { result = await task(); } catch (error) { thrown = error; }
  const elapsed = performance.now() - began;
  entry.samples.push(elapsed);
  bucket?.push(elapsed);
  entry.firstStartedAt = Math.min(entry.firstStartedAt, startedAt);
  entry.lastEndedAt = Math.max(entry.lastEndedAt, Date.now());
  if (result?.data != null) entry.responseBytes += Buffer.byteLength(JSON.stringify(result.data));
  const error = thrown || result?.error || null;
  const status = Number(result?.status ?? error?.status ?? error?.context?.status ?? (error ? 0 : 200)) || 0;
  increment(entry.statuses, String(status));
  if (error) {
    if (expectError?.(error)) entry.expectedErrors += 1;
    else recordError(operation, status, error);
    return { data: result?.data ?? null, error, status };
  }
  const logicalError = validate?.(result);
  if (logicalError) {
    recordError(operation, status, logicalError);
    return { ...result, error: logicalError, status };
  }
  entry.ok += 1;
  return result ?? { data: null, error: null, status };
};

const percentile = (values, percent) => {
  if (!values.length) return 0;
  const ordered = [...values].sort((a, b) => a - b);
  return Number(ordered[Math.ceil((percent / 100) * ordered.length) - 1].toFixed(1));
};
const summarizeOperation = entry => {
  const samples = entry.samples.length;
  const windowSeconds = samples ? Math.max((entry.lastEndedAt - entry.firstStartedAt) / 1000, 0.001) : 0;
  return {
    samples,
    ok: entry.ok,
    errors: entry.errors,
    expectedErrors: entry.expectedErrors,
    errorRate: samples ? Number((entry.errors / samples).toFixed(4)) : 0,
    p50: percentile(entry.samples, 50),
    p95: percentile(entry.samples, 95),
    p99: percentile(entry.samples, 99),
    max: samples ? Number(Math.max(...entry.samples).toFixed(1)) : 0,
    mean: samples ? Number((entry.samples.reduce((sum, value) => sum + value, 0) / samples).toFixed(1)) : 0,
    throughputOpsPerSec: samples ? Number((samples / windowSeconds).toFixed(2)) : 0,
    windowSeconds: Number(windowSeconds.toFixed(1)),
    statuses: entry.statuses,
    errorKinds: entry.errorKinds,
    errorCodes: entry.errorCodes,
    sampleErrors: entry.sampleErrors,
    responseBytes: entry.responseBytes
  };
};

const phases = [];
const runPhase = async (name, task) => {
  const began = Date.now();
  console.log(`[rehearsal] ${name}: started`);
  try {
    return await task();
  } finally {
    const durationMs = Date.now() - began;
    phases.push({ name, durationMs });
    console.log(`[rehearsal] ${name}: finished in ${(durationMs / 1000).toFixed(1)} s`);
  }
};

// Per-candidate failures are recorded instead of aborting the whole run so a
// load run still reports every metric; the correctness gate below then fails
// the rehearsal if any candidate could not complete.
const failedCandidates = [];
const runCandidate = async (candidate, phase, task) => {
  if (candidate.failed) return null;
  try {
    return await task(candidate);
  } catch (error) {
    candidate.failed = `${phase}: ${redact(error?.message || error)}`;
    failedCandidates.push({ studentIndex: candidate.index + 1, reason: candidate.failed });
    return null;
  }
};
const alive = list => list.filter(candidate => !candidate.failed);

const realtimeStats = { subscribeAttempts: 0, subscribed: 0, adminEvents: 0,
  takeoverProbes: 0, takeoverDetected: 0, takeoverDetectionMs: [],
  staleDeviceWritesRejected: 0, staleDeviceWritesAccepted: 0 };
const staleTabStats = { probes: 0, conflictsDetected: 0, overwrites: 0 };
const subscribeAdmin = () => new Promise(resolve => {
  realtimeStats.subscribeAttempts += 1;
  const channel = adminClient.channel(`rehearsal-admin-${prefix}`)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'active_sessions', filter: `exam_id=eq.${examId}` },
      () => { realtimeStats.adminEvents += 1; });
  channels.push(channel);
  const timeout = setTimeout(() => resolve({ error: { message: 'Admin Realtime timed out', code: 'REALTIME_TIMED_OUT' } }), realtimeTimeoutMs);
  channel.subscribe(status => {
    if (status === 'SUBSCRIBED' || status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
      clearTimeout(timeout);
      if (status === 'SUBSCRIBED') realtimeStats.subscribed += 1;
      resolve({ error: status === 'SUBSCRIBED' ? null : { message: `Admin Realtime ${status}`, code: `REALTIME_${status}` } });
    }
  });
});

let examId;
let authIds = [];
const channels = [];
const clients = [];
const authTimers = [];
const backgroundTasks = new Set();
let adminTrafficTimer;
let operationalBefore;
let operationalAfter;
let mediaPath;
let mediaBytes = 0;
let tokenRefreshes = 0;
let reconnectReads = 0;
const backlogObservations = [];
const startedAt = Date.now();
const latencyMs = { start: [], autosave: [], submit: [], retry: [], realtime: [] };
const report = {
  runId: prefix,
  projectRef: expectedProjectRef,
  environment: localTarget ? 'local' : process.env.REHEARSAL_HOSTED_PLAN === 'free' ? 'hosted-free' : 'hosted-unverified',
  candidateCount: students.length,
  questionCount,
  createdStudents: 0,
  authenticatedStudents: 0,
  sessionClaims: 0,
  realtimeSubscribed: 0,
  startedSessions: 0,
  autosavedSessions: 0,
  submittedResults: 0,
  idempotentSubmissionRetries: 0,
  unauthorizedWriteBlocked: false,
  unauthorizedExamWriteBlocked: false,
  studentProvisioningBlocked: false,
  crossAccountSessionsHidden: false,
  crossAccountResultsHidden: false,
  zeroLostOrCrossAccountAnswers: false,
  zeroDuplicateResults: false,
  zeroUnhandledServerErrors: false,
  adminProvisionedStudent: false,
  answersHidden: false,
  cleanupCompleted: false,
  stagingResetRequired: true
};

const newStudentClient = () => {
  const client = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
  clients.push(client);
  return client;
};

const signIn = (client, student, operation) => withRetries(async () => {
  await waitForAuthSignInSlot();
  const result = await measure(operation, () => client.auth.signInWithPassword({ email: student.email, password: studentPassword }));
  if (result.error) throw result.error;
  watchAuth(client, result.data.session, 'token_refresh');
  return result.data;
});

const claimSession = async (client, operation) => {
  // Mirrors AuthPortal.jsx: transient claim failures (5xx, pool exhaustion) are retried.
  for (let attempt = 1; ; attempt += 1) {
    const { data: claim, error: claimError, status } = await measure(operation, () => client.rpc('claim_student_session'));
    if (!claimError && claim?.session_id) return claim;
    const transient = Number(status) >= 500 || /PGRST00[0-3]|57014|55P03|53300/.test(String(claimError?.code || ''));
    if (!transient || attempt >= 4) throw claimError || new Error('Student session claim did not return a signed session ID.');
    const ceiling = Math.min(8000, 1000 * (2 ** (attempt - 1)));
    await wait(ceiling / 2 + Math.random() * (ceiling / 2));
  }
};

const dashboardRead = candidate => measure('dashboard_read', () =>
  candidate.client.rpc('student_dashboard_page', { page_param: 0 }), {
    validate: result => Array.isArray(result.data?.exams) && result.data.exams.length <= 25
      && typeof result.data.has_more === 'boolean'
      && !/"(?:questions|correctAnswer|correct_answer)"/.test(JSON.stringify(result.data))
      ? null : { message: 'Invalid or unbounded dashboard metadata.', code: 'INVALID_DASHBOARD' }
  });
const runtimeRead = (candidate, operation = 'runtime_read') => measure(operation, () =>
  candidate.client.rpc('student_exam_runtime', { exam_id_param: examId }), {
    validate: result => result.data?.session_owned === false
      ? { message: 'Student session has been replaced.', code: 'SESSION_REPLACED' } : null
  });
const downloadMedia = async candidate => {
  const media = await measure('media_download', () => candidate.client.storage.from('exam-assets').download(mediaPath));
  if (media.error) throw media.error;
  operationMetrics('media_download').responseBytes += media.data.size;
};
const refreshAuth = async (client, operation) => {
  const result = await measure(operation, () => client.auth.refreshSession());
  if (result.error) throw result.error;
  if (!result.data?.session) throw new Error('Refresh did not return a session.');
  tokenRefreshes += 1;
  return result.data.session;
};
const watchAuth = (client, session, operation, afterRefresh) => {
  let expiresAt = session.expires_at * 1000;
  let running = false;
  const timer = setInterval(() => {
    if (running || Date.now() < expiresAt - 60_000) return;
    running = true;
    const work = (async () => {
      try {
        const refreshed = await refreshAuth(client, operation);
        expiresAt = refreshed.expires_at * 1000;
        await afterRefresh?.(refreshed);
      } catch { /* The operation metric fails the run; retry at the next tick. */ }
      finally { running = false; }
    })();
    backgroundTasks.add(work);
    work.finally(() => backgroundTasks.delete(work));
  }, 10_000);
  authTimers.push(timer);
};
const observeHealth = async () => {
  const result = await measure('admin_health', () => admin.rpc('admin_operational_health'));
  if (result.error) throw result.error;
  backlogObservations.push({ at: new Date().toISOString(), count: result.data.expired_sessions_pending_finalization,
    oldestDeadlineAt: result.data.expired_sessions_oldest_deadline_at ?? null, scheduler: result.data.scheduler });
  return result.data;
};

const autosaveValidation = (result, payload) => {
  if (isConfirmedSaveReply(result?.data, payload)) return null;
  if (result?.data?.conflict) return { message: 'Unexpected autosave version conflict.', code: 'VERSION_CONFLICT' };
  return { message: 'The exam server returned an invalid autosave response.', code: 'INVALID_AUTOSAVE_RESPONSE' };
};
const isSessionReplaced = error => error?.code === 'EX001' || /student session has been replaced|no longer active/i.test(error?.message || '');
const isAlreadySubmitted = error => /active (?:exam )?session not found|already submitted/i.test(error?.message || '');

// Mirrors the App.jsx autosave engine: whole response object, optimistic
// version, immutable retry parameters, and the frontend transient-error/backoff policy.
const autosave = async (candidate, payload, operation = 'autosave') => {
  accrueSubjectTime(candidate);
  const timingPayload = { ...candidate.subjectTime };
  const expectedVersion = candidate.version;
  const savedGeneration = candidate.accessGeneration;
  let result;
  for (let retry = 0; retry <= 3; retry += 1) {
    if (retry > 0) await wait(retryDelayMs(retry, { capMs: 5000 }));
    result = await measure(operation, () => candidate.client.rpc('sync_active_session_progress', {
      exam_id_param: examId,
      responses_param: payload,
      expected_version_param: expectedVersion,
      access_generation_param: savedGeneration,
      subject_time_seconds_param: timingPayload
    }), { bucket: operation === 'autosave' ? latencyMs.autosave : undefined, validate: reply => autosaveValidation(reply, payload) });
    if (!result.error || !isTransientRpcError(Object.assign(result.error, { httpStatus: result.status }))) break;
  }
  if (isConfirmedSaveReply(result.data, payload)) {
    candidate.version = result.data.version;
    candidate.confirmed = clone(payload);
    candidate.nextPollAt = nextStudentPollAt(Date.now(), studentPollInterval);
    if (result.data.timing_saved) {
      candidate.timingSaved = canonical(timingPayload);
      candidate.lastTimingSaveAt = performance.now();
    }
  } else if (result.data?.conflict) {
    candidate.version = result.data.version;
    if (result.data.user_responses) {
      candidate.responses = clone(result.data.user_responses);
      candidate.confirmed = clone(result.data.user_responses);
    }
  }
  return result;
};

const accrueSubjectTime = candidate => {
  const elapsedSeconds = Math.floor((performance.now() - candidate.subjectTick) / 1000);
  if (elapsedSeconds <= 0) return;
  candidate.subjectTick += elapsedSeconds * 1000;
  candidate.subjectTime[candidate.activeSubject] = (candidate.subjectTime[candidate.activeSubject] || 0) + elapsedSeconds;
};
const syncSubjectTime = async candidate => {
  accrueSubjectTime(candidate);
  const timingPayload = { ...candidate.subjectTime };
  if (!timingFallbackDue(performance.now(), candidate.lastTimingSaveAt, canonical(timingPayload) !== candidate.timingSaved)) return { error: null };
  const result = await measure('subject_time', () => candidate.client.rpc('sync_exam_subject_time', {
    exam_id_param: examId, subject_time_seconds_param: timingPayload,
    access_generation_param: candidate.accessGeneration
  }));
  if (!result.error) {
    candidate.timingSaved = canonical(timingPayload);
    candidate.lastTimingSaveAt = performance.now();
  }
  return result;
};

const mutateAnswers = candidate => {
  const changes = 1 + Math.floor(Math.random() * 2);
  for (let change = 0; change < changes; change += 1) {
    const subject = subjects[Math.floor(Math.random() * subjects.length)];
    const answers = candidate.responses[subject];
    if (!answers?.length) continue;
    const position = Math.floor(Math.random() * answers.length);
    answers[position] = {
      selectedOption: String(Math.floor(Math.random() * 1000)),
      status: Math.random() < 0.2 ? 'ANSWERED_MARKED' : 'ANSWERED'
    };
  }
};

// A second tab still holding an older version must never overwrite the newer
// server copy; the server must answer with a conflict and its own answers.
const staleTabProbe = async candidate => {
  staleTabStats.probes += 1;
  const stalePayload = clone(candidate.confirmed);
  for (const subject of subjects) {
    stalePayload[subject] = (stalePayload[subject] || []).map(() => ({ selectedOption: '999999', status: 'ANSWERED' }));
  }
  const result = await measure('stale_tab_autosave', () => candidate.client.rpc('sync_active_session_progress', {
    exam_id_param: examId,
    responses_param: stalePayload,
    expected_version_param: candidate.version - 1,
    access_generation_param: candidate.accessGeneration
  }));
  if (result.error) return;
  if (result.data?.conflict && Number(result.data.version) === Number(candidate.version)
      && canonical(result.data.user_responses) === canonical(candidate.confirmed)) {
    staleTabStats.conflictsDetected += 1;
    return;
  }
  if (result.data?.success) {
    staleTabStats.overwrites += 1;
    candidate.version = result.data.version;
    candidate.confirmed = stalePayload;
    candidate.responses = clone(stalePayload);
  }
};

const soakCandidate = async (candidate, soakEndsAt) => {
  const now = Date.now();
  let nextAutosave = now + randomBetween(autosaveInterval);
  let nextTimingCheck = now + 60_000;
  let pollFailures = 0;
  const mediaIntervalMs = Math.max(1000, soakSeconds * 1000 / mediaRequests);
  let nextMediaAt = candidate.mediaRemaining ? now + mediaIntervalMs : Infinity;
  let staleTabAt = candidate.staleTab ? now + Math.floor((0.2 + Math.random() * 0.6) * (soakEndsAt - now)) : Infinity;
  for (;;) {
    const next = Math.min(nextAutosave, nextTimingCheck, candidate.nextPollAt, staleTabAt, nextMediaAt);
    if (candidate.failed) return;
    if (next >= soakEndsAt) { await waitUntil(soakEndsAt); return; }
    await waitUntil(next);
    if (next === nextMediaAt) {
      await downloadMedia(candidate);
      candidate.mediaRemaining -= 1;
      nextMediaAt = candidate.mediaRemaining ? Date.now() + mediaIntervalMs : Infinity;
    } else if (next === staleTabAt) {
      staleTabAt = Infinity;
      await staleTabProbe(candidate);
    } else if (next === nextAutosave) {
      mutateAnswers(candidate);
      const result = await autosave(candidate, clone(candidate.responses));
      if (result.error) throw result.error;
      nextAutosave = Date.now() + randomBetween(autosaveInterval);
    } else if (next === nextTimingCheck) {
      const timing = await syncSubjectTime(candidate); // Timing failures must not block grading confirmed answers.
      nextTimingCheck = Date.now() + (timing.error ? 60_000 : Math.max(1000, 60_000 - (performance.now() - candidate.lastTimingSaveAt)));
    } else {
      const result = await runtimeRead(candidate);
      if (isSessionReplaced(result.error)) throw result.error;
      pollFailures = result.error ? pollFailures + 1 : 0;
      candidate.nextPollAt = nextStudentPollAt(Date.now(), studentPollInterval, pollFailures);
    }
  }
};

const takeoverProbe = async candidate => {
  realtimeStats.takeoverProbes += 1;
  const oldClient = candidate.client;
  const newClient = newStudentClient();
  await signIn(newClient, candidate.student, 'takeover_login');
  const claimStartedAt = Date.now();
  const claim = await claimSession(newClient, 'takeover_claim');
  const staleRuntime = await measure('stale_device_runtime', () => oldClient.rpc('student_exam_runtime', { exam_id_param: examId }), {
    expectError: isSessionReplaced
  });
  if ((staleRuntime.error && isSessionReplaced(staleRuntime.error)) || staleRuntime.data?.session_owned === false) {
    realtimeStats.takeoverDetected += 1;
    realtimeStats.takeoverDetectionMs.push(Date.now() - claimStartedAt);
  } else throw new Error('Runtime failed to detect a replaced student session.');
  const staleDevice = await measure('stale_device_autosave', () => oldClient.rpc('sync_active_session_progress', {
    exam_id_param: examId, responses_param: candidate.confirmed,
    expected_version_param: candidate.version, access_generation_param: candidate.accessGeneration
  }), { expectError: isSessionReplaced });
  if (staleDevice.error && isSessionReplaced(staleDevice.error)) realtimeStats.staleDeviceWritesRejected += 1;
  else {
    realtimeStats.staleDeviceWritesAccepted += 1;
    throw new Error('Replaced device did not reject its save.');
  }
  candidate.client = newClient;
  candidate.sessionToken = claim.session_id;
  const runtime = await runtimeRead(candidate);
  if (runtime.error) throw runtime.error;
  candidate.version = runtime.data.version;
  candidate.accessGeneration = runtime.data.access_generation;
};

let failure = null;
try {
  if (process.env.REHEARSAL_ADMIN_REFRESH_TOKEN) {
    const { error } = await adminClient.auth.setSession({ access_token: adminBearer, refresh_token: process.env.REHEARSAL_ADMIN_REFRESH_TOKEN });
    if (error) throw error;
    watchAuth(adminClient, { expires_at: Number(process.env.REHEARSAL_ADMIN_EXPIRES_AT) || 0 }, 'admin_token_refresh', async session => {
      adminBearer = session.access_token;
      adminClient.rest.headers.set('Authorization', `Bearer ${adminBearer}`);
      adminClient.functions.setAuth(adminBearer);
      await adminClient.realtime.setAuth(adminBearer);
    });
  } else if (soakSeconds >= 3000) throw new Error('Long runs require the administrator refresh token and expiry from the wrapper.');
  operationalBefore = await observeHealth();
  if (mediaFile) {
    const contents = readFileSync(mediaFile);
    mediaBytes = contents.byteLength;
    const extension = mediaFile.split('.').pop().toLowerCase();
    const contentType = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' }[extension];
    if (!contentType || mediaBytes === 0 || mediaBytes > 5 * 1024 * 1024) throw new Error('MEDIA_FILE must be a nonempty PNG/JPEG/WebP at most 5 MiB.');
    mediaPath = `${prefix}/diagram.${extension}`;
    const { error } = await admin.storage.from('exam-assets').upload(mediaPath, contents, { contentType });
    if (error) throw error;
    rehearsalQuestions[subjects[0]][0].hasImageOrDiagram = true;
    rehearsalQuestions[subjects[0]][0].questionImageUrl = mediaPath;
  }
  const { error: classError } = await admin.from('classes').insert({ name: className, sections: ['A'] });
  if (classError) throw classError;

  const created = await runPhase('provision candidates', () => limit(students, provisionConcurrency, async student => {
    const { data, error } = await admin.auth.admin.createUser({
      email: student.email,
      password: studentPassword,
      email_confirm: true,
      user_metadata: { student_id: student.studentId, name: student.name, class: className, section: 'A' },
      app_metadata: { provisioned_by: 'admin', account_type: 'student' }
    });
    if (error) throw error;
    const createdStudent = { ...student, authId: data.user.id };
    authIds.push(createdStudent.authId);
    const { error: finalizeError } = await admin.rpc('complete_account_provisioning', {
      account_id_param: createdStudent.authId
    });
    if (finalizeError) {
      await admin.auth.admin.deleteUser(createdStudent.authId);
      throw finalizeError;
    }
    return createdStudent;
  }));
  report.createdStudents = created.length;

  const { data: exam, error: examError } = await admin.from('cbt_exams').insert({
    title: `${prefix} Exam`, status: 'ACTIVE', class: className, section: 'A', questions_data: questionsData
  }).select().single();
  if (examError) throw examError;
  examId = exam.id;
  await adminClient.realtime.setAuth(adminBearer);
  const subscription = await measure('realtime_subscribe', subscribeAdmin, { bucket: latencyMs.realtime });
  if (subscription.error) throw subscription.error;
  let adminTrafficRunning = false;
  adminTrafficTimer = setInterval(() => {
    if (adminTrafficRunning) return;
    adminTrafficRunning = true;
    const work = (async () => {
      try {
        await measure('admin_sessions_read', () => adminClient.from('active_sessions').select('id,status,deadline_at').eq('exam_id', examId).limit(25));
        await observeHealth();
      } catch { /* Metrics retain failures. */ }
      finally { adminTrafficRunning = false; }
    })();
    backgroundTasks.add(work);
    work.finally(() => backgroundTasks.delete(work));
  }, 30_000);

  const candidates = created.map((student, index) => {
    return {
      index,
      student,
      correctTarget: index + 1,
      submissionResponses: responsesForCandidate(index + 1),
      staleTab: false,
      failed: null
    };
  });
  const staleTabCount = soakSeconds > 0 && staleTabPercent > 0
    ? Math.max(1, Math.round((candidates.length * staleTabPercent) / 100))
    : 0;
  // Spread the stale-tab probes across the roster rather than the first N.
  for (let slot = 0; slot < staleTabCount; slot += 1) {
    candidates[Math.floor((slot * candidates.length) / staleTabCount)].staleTab = true;
  }

  // Start rush, step 1: every candidate signs in and claims its session. The
  // global slot gate still paces sign-ins when REHEARSAL_AUTH_SIGNIN_DELAY_MS
  // is set, so this respects Supabase's per-IP anti-abuse limits.
  await runPhase('login and claim', () => limit(candidates, workerConcurrency, candidate => runCandidate(candidate, 'login', async () => {
    candidate.client = newStudentClient();
    const authData = await signIn(candidate.client, candidate.student, 'login');
    if (!authData?.user) throw new Error('Student sign-in did not return a user.');
    candidate.authId = authData.user.id;
    const claim = await claimSession(candidate.client, 'claim');
    candidate.sessionToken = claim.session_id;
  })));
  report.authenticatedStudents = alive(candidates).length;
  report.sessionClaims = alive(candidates).length;

  await runPhase('dashboard polling', () => limit(alive(candidates), workerConcurrency, candidate => runCandidate(candidate, 'pre-start', async () => {
    const dashboard = await dashboardRead(candidate);
    if (dashboard.error) throw dashboard.error;
    candidate.visibleExam = dashboard.data.exams.find(exam => exam.id === examId);
    if (!candidate.visibleExam) throw new Error('Assigned rehearsal exam absent from dashboard page.');
    const visibleText = JSON.stringify(candidate.visibleExam.questions_data);
    if (visibleText.includes('correctAnswer') || visibleText.includes('correct_answer')) throw new Error('Answer key was exposed to a student.');
    if (soakSeconds) await waitUntil(nextStudentPollAt(Date.now(), studentPollInterval));
    const refreshed = await dashboardRead(candidate);
    if (refreshed.error) throw refreshed.error;
  })));
  report.realtimeSubscribed = realtimeStats.subscribed;
  report.answersHidden = alive(candidates).length > 0 && failedCandidates.every(entry => !/Answer key was exposed/.test(entry.reason));

  // Start rush, step 2: everyone presses "Start" at the same instant.
  const startDispatch = [];
  await runPhase('start rush', async () => {
    const startAt = Date.now() + rushLeadMs;
    await limit(alive(candidates), workerConcurrency, candidate => runCandidate(candidate, 'start', async () => {
      await waitUntil(startAt);
      startDispatch.push(Date.now());
      const { data: session, error: sessionError } = await measure('start', () => candidate.client.rpc('start_exam_session', {
        exam_id_param: examId,
        exam_data_param: {},
        responses_param: {}
      }), { bucket: latencyMs.start });
      if (sessionError) throw sessionError;
      candidate.version = session.version;
      candidate.accessGeneration = session.access_generation;
      candidate.targetGrouped = responsesForPaper(session.jumbled_exam_data, candidate.submissionResponses);
      candidate.responses = clone(session.user_responses);
      candidate.confirmed = clone(session.user_responses);
      candidate.subjectTime = {};
      if (/correctAnswer|correct_answer/.test(JSON.stringify(session.jumbled_exam_data))) throw new Error('Answer key was exposed to a student.');
      candidate.activeSubject = subjects[candidate.index % subjects.length];
      candidate.subjectTick = performance.now();
      candidate.lastTimingSaveAt = performance.now();
      candidate.timingSaved = canonical({});
      candidate.nextPollAt = nextStudentPollAt(Date.now(), studentPollInterval);
      const runtime = await runtimeRead(candidate);
      if (runtime.error) throw runtime.error;
      if (mediaPath) await downloadMedia(candidate);
      candidate.mediaRemaining = mediaPath ? mediaRequests - 1 : 0;
      const { error: autosaveError } = await autosave(candidate, clone(session.user_responses));
      if (autosaveError) throw autosaveError;
    }));
  });
  report.startedSessions = alive(candidates).length;
  report.autosavedSessions = alive(candidates).length;

  if (takeoverProbeCount > 0) {
    await runPhase('takeover probes', async () => {
      const probes = alive(candidates).filter(candidate => !candidate.staleTab).slice(-takeoverProbeCount);
      await Promise.all(probes.map(candidate => runCandidate(candidate, 'takeover', takeoverProbe)));
    });
  }

  if (soakSeconds > 0) {
    await runPhase(`soak ${soakSeconds} s`, async () => {
      const soakEndsAt = Date.now() + soakSeconds * 1000;
      const heartbeat = setInterval(() => {
        const autosaves = operationMetrics('autosave');
        console.log(`[rehearsal] soak: ${Math.max(0, Math.round((soakEndsAt - Date.now()) / 1000))} s left, ${autosaves.samples.length} autosaves, ${autosaves.errors} autosave errors`);
      }, 15_000);
      try {
        await Promise.all(alive(candidates).map(candidate => runCandidate(candidate, 'soak', current => soakCandidate(current, soakEndsAt))));
      } finally {
        clearInterval(heartbeat);
      }
    });
  }

  await runPhase('shared-IP refresh and reconnect burst', () => limit(alive(candidates), workerConcurrency, candidate => runCandidate(candidate, 'reconnect', async () => {
    await refreshAuth(candidate.client, 'token_refresh');
    const runtime = await runtimeRead(candidate, 'reconnect_runtime');
    if (runtime.error) throw runtime.error;
    reconnectReads += 1;
    const expectedVersion = candidate.version;
    const payload = clone(candidate.responses);
    const first = await autosave(candidate, payload);
    if (first.error) throw first.error;
    const retry = await measure('lost_save_response_retry', () => candidate.client.rpc('sync_active_session_progress', {
      exam_id_param: examId, responses_param: payload, expected_version_param: expectedVersion,
      access_generation_param: candidate.accessGeneration
    }), { validate: reply => autosaveValidation(reply, payload) });
    if (retry.error) throw retry.error;
    if (Number(retry.data.version) !== Number(candidate.version)) throw new Error('Uncertain-save retry changed the confirmed version.');
  })));
  const sessions = alive(candidates);
  if (!sessions.length) throw new Error('No candidate reached the exam; see failedCandidates.');

  const firstClient = sessions[0].client;
  const { data: foreignSessions, error: foreignSessionsError } = await firstClient
    .from('active_sessions')
    .select('student_id')
    .neq('student_id', sessions[0].student.studentId);
  report.crossAccountSessionsHidden = Boolean(foreignSessionsError) || (foreignSessions || []).length === 0;
  if (!report.crossAccountSessionsHidden) throw new Error('A student could read another candidate\'s active session.');

  const { error: forgedWriteError } = await firstClient.from('student_results').insert({
    exam_id: examId, student_id: 'forged', total_score: 9999, max_score: 9999
  });
  report.unauthorizedWriteBlocked = Boolean(forgedWriteError);
  if (!report.unauthorizedWriteBlocked) throw new Error('A student was able to forge a result row.');

  const { error: forgedExamError } = await firstClient.from('cbt_exams').insert({
    title: `${prefix} Forged Exam`, status: 'ACTIVE', class: className, section: 'A', questions_data: questionsData
  });
  report.unauthorizedExamWriteBlocked = Boolean(forgedExamError);
  if (!report.unauthorizedExamWriteBlocked) throw new Error('A student was able to create an exam.');

  const { error: studentProvisionError } = await firstClient.functions.invoke('manage-student', {
    body: { action: 'create', studentId: `${prefix}-FORGED`, name: 'Forged Student', password: studentPassword, className, section: 'A' }
  });
  report.studentProvisioningBlocked = [401, 403].includes(Number(studentProvisionError?.context?.status));
  if (!report.studentProvisioningBlocked) {
    if (studentProvisionError) {
      throw new Error(`Student provisioning denial was not authoritative (${await functionErrorSummary(studentProvisionError)}).`, {
        cause: studentProvisionError
      });
    }
    throw new Error('A student was able to provision another student.');
  }

  const { data: provisionedStudent, error: provisionError } = await adminClient.functions.invoke('manage-student', {
    body: { action: 'create', studentId: `${prefix}-PROVISIONED`, name: 'Provisioned Student', password: studentPassword, className, section: 'A' }
  });
  if (provisionError) {
    throw new Error(`Admin provisioning failed (${await functionErrorSummary(provisionError)}).`, { cause: provisionError });
  }
  if (!provisionedStudent?.id) throw new Error('Admin provisioning did not return a student ID.');
  authIds.push(provisionedStudent.id);
  const { data: provisionedProfile, error: provisionedProfileError } = await admin
    .from('students').select('student_id, class, section').eq('id', provisionedStudent.id).single();
  const { data: provisionedRole, error: provisionedRoleError } = await admin
    .from('profiles').select('role').eq('id', provisionedStudent.id).single();
  if (provisionedProfileError || provisionedRoleError
      || provisionedProfile?.student_id !== `${prefix}-PROVISIONED`
      || provisionedProfile?.class !== className || provisionedProfile?.section !== 'A'
      || provisionedRole?.role !== 'student') {
    throw new Error('Admin provisioning returned success without a usable, correctly assigned student profile.');
  }
  report.adminProvisionedStudent = true;

  // Submit only the confirmed version after the final answer/timing save.
  await runPhase('deadline rush', async () => {
    const deadlineAt = Date.now() + rushLeadMs;
    await limit(sessions, workerConcurrency, candidate => runCandidate(candidate, 'submit', async () => {
      await waitUntil(deadlineAt);
      const finalSync = await autosave(candidate, clone(candidate.targetGrouped), 'final_sync');
      if (finalSync.error) throw finalSync.error;
      await syncSubjectTime(candidate);
      const { student, correctTarget } = candidate;
      const { data, error } = await measure('submit', () => candidate.client.rpc('submit_exam', {
        exam_id_param: examId, responses_param: null, access_generation_param: candidate.accessGeneration,
        expected_version_param: candidate.version
      }), { bucket: latencyMs.submit });
      if (error) throw error;
      const expectedIncorrect = questionCount - correctTarget;
      const expectedScore = (correctTarget * 4) - expectedIncorrect;
      if (Number(data.totalScore) !== expectedScore
          || Number(data.correct) !== correctTarget
          || Number(data.incorrect) !== expectedIncorrect
          || Number(data.unattempted) !== 0) {
        throw new Error(`Unexpected server score for ${student.studentId}: ${redact(JSON.stringify(data))}`);
      }
      candidate.submitted = data;
    }));
  });

  // Lost-response retry rush: the first HTTP response is assumed lost, so each
  // candidate repeats calculateResults. The final sync must report the session
  // as already submitted and submit_exam must return the committed result.
  await runPhase('submit retry rush', async () => {
    const retryAt = Date.now() + rushLeadMs;
    await limit(alive(sessions), workerConcurrency, candidate => runCandidate(candidate, 'submit retry', async () => {
      await waitUntil(retryAt);
      const retrySync = await measure('submit_retry_sync', () => candidate.client.rpc('sync_active_session_progress', {
        exam_id_param: examId,
        responses_param: candidate.targetGrouped,
        expected_version_param: candidate.version,
        access_generation_param: candidate.accessGeneration
      }), { expectError: isAlreadySubmitted });
      if (!retrySync.error) throw new Error('The active session still accepted autosaves after submission.');
      if (!isAlreadySubmitted(retrySync.error)) throw retrySync.error;
      const { data: retryData, error: retryError } = await measure('submit_retry', () => candidate.client.rpc('submit_exam', {
        exam_id_param: examId,
        responses_param: null,
        access_generation_param: candidate.accessGeneration,
        expected_version_param: candidate.version
      }), { bucket: latencyMs.retry });
      if (retryError) throw retryError;
      for (const key of ['totalScore', 'maxScore', 'correct', 'incorrect', 'unattempted']) {
        if (Number(retryData?.[key]) !== Number(candidate.submitted?.[key])) {
          throw new Error(`Idempotent retry changed ${key} for ${candidate.student.studentId}.`);
        }
      }
    }));
  });
  const submissions = alive(sessions);
  report.submittedResults = submissions.length;
  report.idempotentSubmissionRetries = submissions.length;

  if (failedCandidates.length) {
    throw new Error(`${failedCandidates.length}/${students.length} candidates did not complete; first failure: ${failedCandidates[0].reason}`);
  }

  const { count: resultCount, error: resultCountError } = await admin
    .from('student_results').select('*', { count: 'exact', head: true }).eq('exam_id', examId);
  if (resultCountError) throw resultCountError;
  if (resultCount !== students.length) throw new Error(`Expected ${students.length} saved results, found ${resultCount}.`);

  const { data: storedResults, error: storedResultsError } = await admin
    .from('student_results')
    .select('student_id, total_score, correct, incorrect, unattempted')
    .eq('exam_id', examId);
  if (storedResultsError) throw storedResultsError;
  const expectedCorrectByStudent = new Map(sessions.map(({ student, correctTarget }) => [student.studentId, correctTarget]));
  const storedStudentIds = new Set();
  for (const row of storedResults || []) {
    const expectedCorrect = expectedCorrectByStudent.get(row.student_id);
    const expectedIncorrect = questionCount - expectedCorrect;
    const expectedScore = (expectedCorrect * 4) - expectedIncorrect;
    if (!expectedCorrect
        || storedStudentIds.has(row.student_id)
        || Number(row.correct) !== expectedCorrect
        || Number(row.incorrect) !== expectedIncorrect
        || Number(row.unattempted) !== 0
        || Number(row.total_score) !== expectedScore) {
      throw new Error(`Lost, duplicated, or cross-account grading detected for ${row.student_id}.`);
    }
    storedStudentIds.add(row.student_id);
  }
  if (storedStudentIds.size !== students.length) throw new Error('Not every candidate has one verified result.');
  report.zeroLostOrCrossAccountAnswers = true;
  report.zeroDuplicateResults = true;
  report.zeroIncorrectGrades = true;

  const { data: foreignResults, error: foreignResultsError } = await firstClient
    .from('student_results')
    .select('student_id')
    .neq('student_id', sessions[0].student.studentId);
  report.crossAccountResultsHidden = Boolean(foreignResultsError) || (foreignResults || []).length === 0;
  if (!report.crossAccountResultsHidden) throw new Error('A student could read another candidate\'s result.');

  const { count: sessionCount, error: sessionCountError } = await admin
    .from('active_sessions').select('*', { count: 'exact', head: true }).eq('exam_id', examId);
  if (sessionCountError) throw sessionCountError;
  if (sessionCount !== 0) throw new Error(`Expected 0 remaining sessions, found ${sessionCount}.`);
  if (abandonmentProbes) {
    await runPhase('abandonment finalizer drill', async () => {
      const { data: abandonedExam, error } = await admin.from('cbt_exams').insert({
        title: `${prefix} Abandonment`, status: 'ACTIVE', class: className, section: 'A',
        questions_data: { ...questionsData, duration: 1 }
      }).select('id').single();
      if (error) throw error;
      const probes = sessions.slice(0, abandonmentProbes);
      await limit(probes, workerConcurrency, async candidate => {
        const started = await measure('abandonment_start', () => candidate.client.rpc('start_exam_session', {
          exam_id_param: abandonedExam.id, exam_data_param: {}, responses_param: {}
        }));
        if (started.error) throw started.error;
        const answers = responsesForPaper(started.data.jumbled_exam_data, candidate.submissionResponses);
        const saved = await measure('abandonment_save', () => candidate.client.rpc('sync_active_session_progress', {
          exam_id_param: abandonedExam.id, responses_param: answers,
          expected_version_param: started.data.version, access_generation_param: started.data.access_generation
        }), { validate: reply => autosaveValidation(reply, answers) });
        if (saved.error) throw saved.error;
      });
      const finalizerWaitMs = (4 + Math.ceil(probes.length / 200)) * 60_000;
      const timeoutAt = Date.now() + finalizerWaitMs;
      let remaining = probes.length;
      while (remaining && Date.now() < timeoutAt) {
        await wait(15_000);
        await observeHealth();
        const pending = await admin.from('active_sessions').select('id', { count: 'exact', head: true }).eq('exam_id', abandonedExam.id);
        if (pending.error) throw pending.error;
        remaining = pending.count;
      }
      if (remaining) throw new Error(`Finalizer did not drain abandonment attempts within ${finalizerWaitMs / 60_000} minutes.`);
      const results = await admin.from('student_results').select('student_id,total_score').eq('exam_id', abandonedExam.id);
      if (results.error) throw results.error;
      if (results.data.length !== probes.length || results.data.some(row => {
        const candidate = probes.find(item => item.student.studentId === row.student_id);
        return !candidate || Number(row.total_score) !== candidate.correctTarget * 4 - (questionCount - candidate.correctTarget);
      })) throw new Error('Finalizer lost or incorrectly graded a confirmed abandonment snapshot.');
      report.abandonmentVerified = probes.length;
    });
  }
  operationalAfter = await observeHealth();
  report.zeroUnhandledServerErrors = true;
  report.startRushDispatchSpreadMs = startDispatch.length ? Math.max(...startDispatch) - Math.min(...startDispatch) : 0;
} catch (error) {
  failure = redact(error?.message || error);
} finally {
  clearInterval(adminTrafficTimer);
  authTimers.forEach(clearInterval);
  await Promise.all([...backgroundTasks]);
  await Promise.all(channels.map(channel => channel.unsubscribe().catch(() => undefined)));
  adminClient.realtime.disconnect();
  for (const client of clients) {
    try { client.realtime.disconnect(); } catch {}
  }
  // Submitted results are intentionally immutable. Do not claim that deleting
  // Auth users cleans the rehearsal. Reset this disposable staging project from
  // its baseline after saving the JSON report.
  report.cleanupCompleted = false;
  report.stagingResetRequired = true;
}

report.durationMs = Date.now() - startedAt;
report.latencyMs = Object.fromEntries(Object.entries(latencyMs).map(([name, values]) => [name, {
  samples: values.length,
  p50: percentile(values, 50),
  p95: percentile(values, 95),
  p99: percentile(values, 99),
  max: values.length ? Number(Math.max(...values).toFixed(1)) : 0
}]));

const operations = Object.fromEntries([...metrics.entries()].map(([name, entry]) => [name, summarizeOperation(entry)]));
const totalOperations = Object.values(operations).reduce((sum, entry) => sum + entry.samples, 0);
const totalErrors = Object.values(operations).reduce((sum, entry) => sum + entry.errors, 0);
const statusBreakdown = {};
const errorKindBreakdown = {};
for (const entry of Object.values(operations)) {
  for (const [status, count] of Object.entries(entry.statuses)) statusBreakdown[status] = (statusBreakdown[status] || 0) + count;
  for (const [kind, count] of Object.entries(entry.errorKinds)) errorKindBreakdown[kind] = (errorKindBreakdown[kind] || 0) + count;
}
const realtimeSubscribeRate = realtimeStats.subscribeAttempts ? realtimeStats.subscribed / realtimeStats.subscribeAttempts : 0;

const checks = [];
const check = (name, actual, limitValue, passed) => checks.push({ name, actual, limit: limitValue, passed });
for (const [name, entry] of Object.entries(operations)) {
  if (!entry.samples) continue;
  if (thresholds.p95Ms[name] !== undefined) check(`${name} p95 ms`, entry.p95, `<= ${thresholds.p95Ms[name]}`, entry.p95 <= thresholds.p95Ms[name]);
  check(`${name} error rate`, entry.errorRate, `<= ${thresholds.maxErrorRate}`, entry.errors / entry.samples <= thresholds.maxErrorRate);
}
check('realtime subscribe rate', Number(realtimeSubscribeRate.toFixed(4)), `>= ${thresholds.minRealtimeSubscribeRate}`, realtimeSubscribeRate >= thresholds.minRealtimeSubscribeRate);
if (realtimeStats.takeoverProbes) {
  check('takeover detected by runtime', realtimeStats.takeoverDetected, `= ${realtimeStats.takeoverProbes}`, realtimeStats.takeoverDetected === realtimeStats.takeoverProbes);
  check('stale device writes accepted', realtimeStats.staleDeviceWritesAccepted, '= 0', realtimeStats.staleDeviceWritesAccepted === 0);
}
if (staleTabStats.probes) {
  check('stale tab overwrites', staleTabStats.overwrites, '= 0', staleTabStats.overwrites === 0);
  check('stale tab conflicts detected', staleTabStats.conflictsDetected, `= ${staleTabStats.probes}`, staleTabStats.conflictsDetected === staleTabStats.probes);
}
const thresholdsPassed = checks.every(entry => entry.passed);

report.load = {
  config: {
    workerConcurrency,
    authSignInDelayMs,
    soakSeconds,
    autosaveIntervalMs: autosaveInterval,
    studentPollIntervalMs: studentPollInterval,
    timingFallbackMs: 60_000,
    abandonmentProbes,
    mediaRequests,
    fullDurationSeconds,
    staleTabPercent,
    takeoverProbes: takeoverProbeCount,
    rushLeadMs
  },
  phases,
  operations,
  totals: {
    operations: totalOperations,
    errors: totalErrors,
    errorRate: totalOperations ? Number((totalErrors / totalOperations).toFixed(4)) : 0,
    throughputOpsPerSec: Number((totalOperations / Math.max(report.durationMs / 1000, 0.001)).toFixed(2)),
    statuses: statusBreakdown,
    errorKinds: errorKindBreakdown
  },
  realtime: {
    ...realtimeStats,
    subscribeRate: Number(realtimeSubscribeRate.toFixed(4)),
    takeoverDetectionMs: {
      samples: realtimeStats.takeoverDetectionMs.length,
      p50: percentile(realtimeStats.takeoverDetectionMs, 50),
      max: realtimeStats.takeoverDetectionMs.length ? Math.max(...realtimeStats.takeoverDetectionMs) : 0
    }
  },
  staleTab: staleTabStats,
  failedCandidates: failedCandidates.slice(0, 20),
  failedCandidateCount: failedCandidates.length,
  thresholds: { config: thresholds, enforced: enforceThresholds, passed: thresholdsPassed, checks }
};
report.finalizer = { observations: backlogObservations };
report.usage = projectUsage({ responseBytes: Object.values(operations).reduce((sum, entry) => sum + entry.responseBytes, 0),
  databaseBefore: operationalBefore?.database_size_bytes, databaseAfter: operationalAfter?.database_size_bytes,
  sittingsPerMonth: monthlySittings });
report.usage.academicStorageBytesBefore = operationalBefore?.academic_storage_bytes ?? null;
report.usage.academicStorageBytesAfter = operationalAfter?.academic_storage_bytes ?? null;
report.usage.caveat = 'JSON response payload plus downloaded media only; excludes HTTP headers, Realtime, backups and protocol overhead. Verify project dashboard egress and retained table/index growth.';
report.tokenRefreshes = tokenRefreshes;
report.fullDurationValidated = fullDurationSeconds > 0
  && (phases.find(phase => phase.name === `soak ${soakSeconds} s`)?.durationMs || 0) >= fullDurationSeconds * 1000
  && tokenRefreshes >= students.length;
report.representativeMediaValidated = Boolean(mediaPath && mediaBytes && operationMetrics('media_download').ok >= students.length * mediaRequests && process.env.REHEARSAL_REPRESENTATIVE_FIXTURE_CONFIRMED === '1');
report.operationalDrillsValidated = Boolean(report.abandonmentVerified >= Math.min(students.length, workerConcurrency) && reconnectReads === students.length && realtimeStats.takeoverDetected === takeoverProbeCount && takeoverProbeCount > 0);
report.failure = failure;
report.passed = !failure && (thresholdsPassed || !enforceThresholds);
let historicalReports = [];
try { historicalReports = (process.env.REHEARSAL_CAPACITY_REPORTS || '').split(',').filter(Boolean).map(path => JSON.parse(readFileSync(path, 'utf8'))); }
catch (error) { report.failure = `Capacity report could not be read: ${redact(error.message)}`; report.passed = false; }
report.capacity = operatingCapacity([...historicalReports, report]);

const pad = (value, width, right = false) => (right ? String(value).padStart(width) : String(value).padEnd(width));
const header = [pad('operation', 22), pad('n', 6, true), pad('err', 5, true), pad('err%', 6, true), pad('p50', 8, true),
  pad('p95', 8, true), pad('p99', 8, true), pad('max', 8, true), pad('ops/s', 8, true), pad('p95 limit', 10, true), '  top statuses'].join(' ');
console.log('');
console.log(`[rehearsal] ${students.length} candidates, concurrency ${workerConcurrency}, soak ${soakSeconds} s, duration ${(report.durationMs / 1000).toFixed(1)} s`);
console.log(header);
console.log('-'.repeat(header.length));
for (const [name, entry] of Object.entries(operations)) {
  const statuses = Object.entries(entry.statuses).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([status, count]) => `${status}:${count}`).join(' ');
  console.log([pad(name, 22), pad(entry.samples, 6, true), pad(entry.errors, 5, true), pad((entry.errorRate * 100).toFixed(2), 6, true),
    pad(entry.p50, 8, true), pad(entry.p95, 8, true), pad(entry.p99, 8, true), pad(entry.max, 8, true),
    pad(entry.throughputOpsPerSec, 8, true), pad(thresholds.p95Ms[name] ?? '-', 10, true), `  ${statuses}`].join(' '));
}
console.log(`[rehearsal] admin Realtime: ${realtimeStats.subscribed}/${realtimeStats.subscribeAttempts}; runtime takeovers ${realtimeStats.takeoverDetected}/${realtimeStats.takeoverProbes}; stale tab ${staleTabStats.conflictsDetected}/${staleTabStats.probes}, overwrites ${staleTabStats.overwrites}`);
console.log(`[rehearsal] errors by kind: ${JSON.stringify(errorKindBreakdown)}`);
for (const entry of checks.filter(item => !item.passed)) {
  console.log(`[rehearsal] THRESHOLD FAILED: ${entry.name} = ${entry.actual} (required ${entry.limit})`);
}
console.log(`[rehearsal] ${report.passed ? 'PASSED' : 'FAILED'}${failure ? ` - ${failure}` : ''}`);

try {
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  console.log(`[rehearsal] JSON report written to ${reportPath}`);
} catch (error) {
  console.log(`[rehearsal] Could not write JSON report: ${redact(error?.message)}`);
}

if (failure) console.error(`Rehearsal failed: ${failure}`);
// The final stdout line stays the machine-readable report (the connected
// staging wrapper parses it).
console.log(JSON.stringify(report));
process.exitCode = report.passed ? 0 : 1;
