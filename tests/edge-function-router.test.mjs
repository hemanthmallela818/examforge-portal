// Behavioural tests for the manage-student Edge Function router. The real
// module graph is transpiled and run under Node with injected fake clients, so
// every action's status codes, response bodies and call ordering are pinned.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadEdgeModules } from './support/edgeSource.mjs';

const modules = await loadEdgeModules(['index.ts', 'actions/index.ts', 'validation.ts', 'log.ts']);
const { handleManageStudent, STUDENT_EMAIL_DOMAIN } = modules['index.ts'];
const { ACTIONS } = modules['actions/index.ts'];
const { SCOPED_CLEANUP_CONFIRMATIONS } = modules['validation.ts'];
const { createLogger } = modules['log.ts'];

const ADMIN_ID = '10000000-0000-4000-8000-000000000001';
const STUDENT_UUID = '20000000-0000-4000-8000-000000000002';
const NEW_USER_ID = '30000000-0000-4000-8000-000000000003';
const STRONG_PASSWORD = 'correct-horse-battery';

function request(body, { method = 'POST', headers = {}, raw } = {}) {
  return new Request('http://localhost/manage-student', {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token-abc', ...headers },
    body: method === 'GET' ? undefined : (raw ?? JSON.stringify(body)),
  });
}

/**
 * Fake caller/admin clients. Every call is recorded in `calls` in order.
 * Options override the default happy path (AAL2 admin, not root).
 */
function fakeClients(options = {}) {
  const calls = [];
  const tables = {
    profiles: filters => ({ data: { role: filters.id === ADMIN_ID ? 'admin' : 'student' }, error: null }),
    students: () => ({ data: null, error: null }),
    classes: () => ({ data: { sections: ['A', 'B'] }, error: null }),
    ...options.tables,
  };
  const rpcResult = (overrides, name, args, fallback) => (
    overrides?.[name] ? overrides[name](args) : fallback
  );
  const admin = {
    from(table) {
      const filters = {};
      const builder = {
        select(columns) { filters.select = columns; return builder; },
        eq(column, value) { filters[column] = value; return builder; },
        async maybeSingle() {
          calls.push(['select', table, { ...filters }]);
          return tables[table](filters);
        },
        async insert(row) {
          calls.push(['insert', table, row]);
          return options.insert ? options.insert(table, row) : { error: null };
        },
      };
      return builder;
    },
    async rpc(name, args) {
      calls.push(['admin.rpc', name, args]);
      return rpcResult(options.adminRpc, name, args, { data: null, error: null });
    },
    auth: {
      admin: {
        async createUser(attributes) {
          calls.push(['createUser', attributes]);
          return options.createUser ? options.createUser(attributes) : { data: { user: { id: NEW_USER_ID } }, error: null };
        },
        async deleteUser(id) {
          calls.push(['deleteUser', id]);
          return options.deleteUser ? options.deleteUser(id) : { error: null };
        },
        async updateUserById(id, attributes) {
          calls.push(['updateUserById', id, attributes]);
          return options.updateUser ? options.updateUser(id) : { error: null };
        },
      },
    },
  };
  const caller = {
    auth: {
      getUser: async () => (options.unauthenticated
        ? { data: { user: null }, error: new Error('invalid token') }
        : { data: { user: { id: ADMIN_ID } }, error: null }),
    },
    async rpc(name, args) {
      calls.push(['caller.rpc', name, args]);
      const fallback = name === 'is_admin_aal2' ? { data: options.aal2 ?? true, error: null }
        : name === 'is_root_developer' ? { data: options.root ?? false, error: null }
          : { data: null, error: null };
      return rpcResult(options.callerRpc, name, args, fallback);
    },
  };
  return { clients: { caller, admin }, calls };
}

async function call(body, options = {}, requestOptions = {}) {
  const { clients, calls } = fakeClients(options);
  const response = await handleManageStudent(request(body, requestOptions), clients);
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { response, status: response.status, body: json, text, calls };
}

const NAMED_CALLS = new Set(['select', 'insert', 'admin.rpc', 'caller.rpc']);
const callNames = calls => calls.map(([kind, name]) => (NAMED_CALLS.has(kind) ? `${kind}:${name}` : kind));

function assertError(result, status, error, code) {
  assert.equal(result.status, status, `${error}: status`);
  assert.equal(result.body.error, error);
  assert.equal(result.body.code, code);
  assert.match(result.body.correlationId, /^[0-9a-f-]{36}$/);
  assert.equal(result.response.headers.get('X-Correlation-Id'), result.body.correlationId);
}

// Silence the structured log during tests; individual tests capture it.
function captureLogs() {
  const lines = [];
  const original = { log: console.log, warn: console.warn, error: console.error };
  for (const level of ['log', 'warn', 'error']) console[level] = line => lines.push(String(line));
  return { lines, restore: () => Object.assign(console, original) };
}
let quiet;
test.beforeEach(() => { quiet = captureLogs(); });
test.afterEach(() => quiet.restore());

test('action table: names, authority and validation order', () => {
  const table = Object.fromEntries(Object.entries(ACTIONS).map(([name, definition]) => [
    name, `${definition.authority}${definition.validateBeforeAuthority ? '+validate-first' : ''}`,
  ]));
  assert.deepEqual(table, {
    'create-admin': 'root',
    'preview-reset': 'root',
    'reset-application': 'root',
    'clear-scoped-data': 'root+validate-first',
    'create': 'admin',
    'update-assignment': 'admin',
    'reset-student-password': 'admin',
  });
  assert.equal(STUDENT_EMAIL_DOMAIN, 'students.examforge.invalid');
  assert.deepEqual({ ...SCOPED_CLEANUP_CONFIRMATIONS }, {
    student_results: 'CLEAR EXAM RESULTS',
    cbt_exams: 'CLEAR EXAMS',
    question_bank: 'CLEAR QUESTION BANK',
  });
});

test('pipeline: CORS, method, size, content type and body parsing', async () => {
  const previous = process.env.ALLOWED_ORIGINS;
  process.env.ALLOWED_ORIGINS = 'https://exam.example.edu';
  try {
    const { clients } = fakeClients();
    const preflight = await handleManageStudent(new Request('http://localhost/x', {
      method: 'OPTIONS', headers: { Origin: 'https://exam.example.edu' },
    }), clients);
    assert.equal(preflight.status, 200);
    assert.equal(await preflight.text(), 'ok');
    assert.equal(preflight.headers.get('Access-Control-Allow-Origin'), 'https://exam.example.edu');
    assert.equal(preflight.headers.get('Access-Control-Allow-Methods'), 'POST, OPTIONS');

    const rejected = await handleManageStudent(request({ action: 'create' }, { headers: { Origin: 'https://evil.example' } }), clients);
    assert.equal(rejected.status, 403);
    assert.deepEqual(await rejected.json(), { error: 'Origin not allowed' });
    assert.equal(rejected.headers.get('Access-Control-Allow-Origin'), null, 'origin rejection carries no CORS grant');
    assert.equal(rejected.headers.get('X-Correlation-Id'), null);
  } finally {
    if (previous === undefined) delete process.env.ALLOWED_ORIGINS;
    else process.env.ALLOWED_ORIGINS = previous;
  }

  assertError(await call(null, {}, { method: 'GET' }), 405, 'Method not allowed', 'UNAVAILABLE');
  assertError(await call({ action: 'create' }, {}, { headers: { 'Content-Length': '16385' } }), 413, 'Payload too large', 'VALIDATION_FAILED');
  assertError(await call({ action: 'create', pad: 'x'.repeat(17000) }), 413, 'Payload too large', 'VALIDATION_FAILED');
  assertError(await call(null, {}, { headers: { 'Content-Type': 'text/plain' } }), 415, 'Content-Type must be application/json', 'UNAVAILABLE');
  assertError(await call(null, {}, { raw: '' }), 400, 'Request body cannot be empty', 'VALIDATION_FAILED');
  assertError(await call(null, {}, { raw: '{nope' }), 400, 'Invalid JSON request body', 'VALIDATION_FAILED');
  assertError(await call({ action: 'create' }, {}, { headers: { Authorization: '' } }), 401, 'Authentication required', 'AUTH_REQUIRED');
  assertError(await call({ action: 'create' }, { unauthenticated: true }), 401, 'Authentication required', 'AUTH_REQUIRED');
});

test('authority: AAL2 for admin and unknown actions, root check for root actions, profile role for all', async () => {
  const notAal2 = await call({ action: 'create' }, { aal2: false });
  assertError(notAal2, 403, 'Active administrator access required', 'FORBIDDEN');
  assert.deepEqual(callNames(notAal2.calls), ['caller.rpc:is_admin_aal2']);

  assertError(await call({ action: 'nope' }, { aal2: false }), 403, 'Active administrator access required', 'FORBIDDEN');
  for (const action of ['nope', 'constructor', '__proto__', 'toString', '']) {
    assertError(await call({ action }), 400, 'Unsupported action', 'VALIDATION_FAILED');
  }
  assertError(await call(null), 400, 'Unsupported action', 'VALIDATION_FAILED');

  // Root-only actions never ask for AAL2, but still require the admin profile.
  const rootPreview = await call({ action: 'preview-reset' }, { aal2: false, root: true, adminRpc: {
    root_application_reset_preview_for_actor: () => ({ data: { students: 3 }, error: null }),
  } });
  assert.equal(rootPreview.status, 200);
  assert.deepEqual(rootPreview.body, { preview: { students: 3 } });
  assert.ok(!callNames(rootPreview.calls).includes('caller.rpc:is_admin_aal2'));
  assert.deepEqual(callNames(rootPreview.calls), [
    'select:profiles', 'caller.rpc:is_root_developer', 'admin.rpc:root_application_reset_preview_for_actor',
  ]);

  const studentProfile = await call({ action: 'preview-reset' }, { root: true, tables: {
    profiles: () => ({ data: { role: 'student' }, error: null }),
  } });
  assertError(studentProfile, 403, 'Administrator access required', 'FORBIDDEN');

  for (const action of ['preview-reset', 'reset-application', 'create-admin']) {
    assertError(await call({ action }), 403, 'Root developer access required', 'FORBIDDEN');
  }
  assertError(await call({ action: 'preview-reset' }, { callerRpc: {
    is_root_developer: () => ({ data: true, error: { message: 'boom' } }),
  } }), 403, 'Root developer access required', 'FORBIDDEN');
});

test('clear-scoped-data validates its confirmation before the root check', async () => {
  const good = { action: 'clear-scoped-data', target: 'cbt_exams', confirmation: 'CLEAR EXAMS' };
  assertError(await call({ ...good, confirmation: 'clear exams' }), 400, 'Exact scoped cleanup confirmation is required', 'VALIDATION_FAILED');
  assertError(await call({ ...good, target: 'students', confirmation: 'CLEAR STUDENTS' }, { root: true }), 400, 'Exact scoped cleanup confirmation is required', 'VALIDATION_FAILED');
  assertError(await call({ ...good, target: 'constructor', confirmation: String(Object) }, { root: true }), 400, 'Exact scoped cleanup confirmation is required', 'VALIDATION_FAILED');
  assertError(await call(good), 403, 'Root developer access required', 'FORBIDDEN');

  const cleared = await call(good, { root: true, adminRpc: {
    root_clear_scoped_data_for_actor: () => ({ data: { deleted: { cbt_exams: 4 } }, error: null }),
  } });
  assert.equal(cleared.status, 200);
  assert.deepEqual(cleared.body, { cleared: true, target: 'cbt_exams', deleted: { cbt_exams: 4 } });
  assert.deepEqual(cleared.calls.at(-1), ['admin.rpc', 'root_clear_scoped_data_for_actor', {
    actor_id_param: ADMIN_ID, target_param: 'cbt_exams', confirmation_param: 'CLEAR EXAMS',
  }]);

  // safeDbMessage: only deliberate SQL errors (P0001/42501) reach the client.
  const internal = await call(good, { root: true, adminRpc: {
    root_clear_scoped_data_for_actor: () => ({ data: null, error: { code: '23503', message: 'fk_secret_constraint' } }),
  } });
  assertError(internal, 500, 'Scoped cleanup failed', 'UNAVAILABLE');
  assert.ok(!internal.text.includes('fk_secret_constraint'));
  for (const code of ['P0001', '42501']) {
    assertError(await call(good, { root: true, adminRpc: {
      root_clear_scoped_data_for_actor: () => ({ data: null, error: { code, message: 'Deliberate message' } }),
    } }), 500, 'Deliberate message', 'UNAVAILABLE');
  }
});

test('preview-reset and reset-application: confirmation, batched Auth cleanup and retryable partial failure', async () => {
  assertError(await call({ action: 'preview-reset' }, { root: true, adminRpc: {
    root_application_reset_preview_for_actor: () => ({ data: null, error: { code: 'XX000', message: 'internal' } }),
  } }), 500, 'Unable to preview the application reset', 'UNAVAILABLE');

  // Authority is checked before the confirmation for reset-application.
  assertError(await call({ action: 'reset-application', confirmation: 'nope' }), 403, 'Root developer access required', 'FORBIDDEN');
  assertError(await call({ action: 'reset-application', confirmation: 'reset application data' }, { root: true }), 400, 'Exact reset confirmation is required', 'VALIDATION_FAILED');
  assertError(await call({ action: 'reset-application', confirmation: 'RESET APPLICATION DATA' }, { root: true, adminRpc: {
    root_reset_application_data_for_actor: () => ({ data: null, error: { code: '40001', message: 'serialization' } }),
  } }), 500, 'Application data reset failed', 'UNAVAILABLE');

  const ids = Array.from({ length: 23 }, (_, index) => `user-${index}`);
  let inFlight = 0;
  let maxInFlight = 0;
  const reset = { action: 'reset-application', confirmation: 'RESET APPLICATION DATA' };
  const resetRpc = { root_reset_application_data_for_actor: () => ({ data: { deleted: { students: 23 }, auth_user_ids: ids }, error: null }) };
  const trackedDelete = failing => async id => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise(resolve => setImmediate(resolve));
    inFlight -= 1;
    return { error: failing.has(id) ? new Error('auth down') : null };
  };

  const ok = await call(reset, { root: true, adminRpc: resetRpc, deleteUser: trackedDelete(new Set()) });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body, { reset: true, deleted: { students: 23 }, deletedAuthUsers: 23, preserved: 'root_and_administrator_accounts' });
  assert.equal(maxInFlight, 10, 'Auth accounts are deleted in batches of 10');
  assert.deepEqual(ok.calls.find(entry => entry[1] === 'root_reset_application_data_for_actor')[2], {
    actor_id_param: ADMIN_ID, confirmation_param: 'RESET APPLICATION DATA',
  });

  const partial = await call(reset, { root: true, adminRpc: resetRpc, deleteUser: trackedDelete(new Set(['user-3', 'user-17'])) });
  assertError(partial, 500, 'Database reset completed, but some student sign-in accounts require a reset retry', 'UNAVAILABLE');
  assert.equal(partial.body.deletedAuthUsers, 21);
  assert.equal(partial.body.failedAuthUsers, 2);
  assert.deepEqual(partial.body.deleted, { students: 23 });
  assert.ok(!partial.text.includes('user-3'), 'Auth account IDs are never returned');
  const incomplete = quiet.lines.map(line => JSON.parse(line)).find(line => line.event === 'reset_auth_cleanup_incomplete');
  assert.equal(incomplete.correlationId, partial.body.correlationId, 'logged and returned correlation IDs match');
});

test('create-admin: root check before validation, provisioning, and rollback', async () => {
  const valid = { action: 'create-admin', email: ' New.Admin@School.EDU ', name: ' Ada ', password: STRONG_PASSWORD };
  assertError(await call({ ...valid, email: 'bad' }), 403, 'Root developer access required', 'FORBIDDEN');
  const invalidMessage = 'Enter a valid email, name, and password of 12 to 128 characters';
  assertError(await call({ ...valid, email: 'bad' }, { root: true }), 400, invalidMessage, 'VALIDATION_FAILED');
  assertError(await call({ ...valid, password: 'x'.repeat(11) }, { root: true }), 400, invalidMessage, 'VALIDATION_FAILED');
  assertError(await call({ ...valid, password: 'x'.repeat(129) }, { root: true }), 400, invalidMessage, 'VALIDATION_FAILED');
  assertError(await call({ ...valid, name: '  ' }, { root: true }), 400, invalidMessage, 'VALIDATION_FAILED');

  const created = await call(valid, { root: true });
  assert.equal(created.status, 201);
  assert.deepEqual(created.body, { id: NEW_USER_ID, email: 'new.admin@school.edu', name: 'Ada' });
  const [, attributes] = created.calls.find(([kind]) => kind === 'createUser');
  assert.deepEqual(attributes.app_metadata, { provisioned_by: 'admin', account_type: 'admin' });
  assert.deepEqual(created.calls.find(entry => entry[1] === 'register_managed_administrator')[2], {
    account_id_param: NEW_USER_ID, creator_id_param: ADMIN_ID,
  });

  assertError(await call(valid, { root: true, createUser: () => ({ data: null, error: { message: 'exists' } }) }),
    400, 'Administrator creation failed; check whether the email already exists', 'VALIDATION_FAILED');

  const finalizeFails = await call(valid, { root: true, adminRpc: {
    complete_account_provisioning: () => ({ data: null, error: { code: 'XX000' } }),
  } });
  assertError(finalizeFails, 500, 'Account setup failed and was rolled back', 'UNAVAILABLE');
  assert.ok(!callNames(finalizeFails.calls).includes('admin.rpc:register_managed_administrator'));
  assert.deepEqual(finalizeFails.calls.at(-1), ['deleteUser', NEW_USER_ID]);

  assertError(await call(valid, {
    root: true,
    adminRpc: { register_managed_administrator: () => ({ data: null, error: { code: 'P0001' } }) },
    deleteUser: () => ({ error: new Error('down') }),
  }), 500, 'Account setup failed; incomplete account needs operator cleanup', 'UNAVAILABLE');
});

test('reset-student-password: validation, target checks, audit-before-reset and failure audit', async () => {
  const valid = { action: 'reset-student-password', studentUserId: STUDENT_UUID, password: STRONG_PASSWORD };
  const studentTables = {
    students: () => ({ data: { student_id: 'STU-1', archived_at: null }, error: null }),
  };
  assertError(await call({ ...valid, studentUserId: 'not-a-uuid' }), 400, 'A valid student user ID is required', 'VALIDATION_FAILED');
  assertError(await call({ ...valid, password: 'short' }), 400, 'Password must be between 12 and 128 characters', 'VALIDATION_FAILED');
  assertError(await call(valid, { tables: { profiles: () => ({ data: { role: 'admin' }, error: null }) } }),
    400, 'Target user is not a student', 'VALIDATION_FAILED');
  assertError(await call(valid), 404, 'Student record not found', 'NOT_FOUND');
  assertError(await call(valid, { tables: { students: () => ({ data: { student_id: 'STU-1', archived_at: '2026-01-01' }, error: null }) } }),
    409, 'Reactivate this student before resetting the password', 'CONFLICT');

  const auditFails = await call(valid, { tables: studentTables, insert: () => ({ error: { code: '42P01' } }) });
  assertError(auditFails, 500, 'The password reset could not be recorded, so it was not applied', 'UNAVAILABLE');
  assert.ok(!callNames(auditFails.calls).includes('updateUserById'), 'password is not changed without an audit record');

  const updateFails = await call(valid, { tables: studentTables, updateUser: () => ({ error: new Error('gotrue') }) });
  assertError(updateFails, 500, 'Failed to update student password', 'UNAVAILABLE');
  const audits = updateFails.calls.filter(([kind]) => kind === 'insert').map(([, , row]) => row);
  assert.deepEqual(audits.map(row => row.action), ['RESET_STUDENT_PASSWORD', 'RESET_STUDENT_PASSWORD_FAILED']);
  for (const row of audits) {
    assert.deepEqual(row, {
      actor_user_id: ADMIN_ID, action: row.action, target_type: 'student', target_id: STUDENT_UUID,
      metadata: { student_id: 'STU-1' },
    });
  }

  const done = await call(valid, { tables: studentTables });
  assert.equal(done.status, 200);
  assert.deepEqual(done.body, { success: true, studentUserId: STUDENT_UUID });
  const order = callNames(done.calls).filter(name => name === 'insert:admin_audit_events' || name === 'updateUserById');
  assert.deepEqual(order, ['insert:admin_audit_events', 'updateUserById'], 'audit is written before the password changes');
  assert.deepEqual(done.calls.find(([kind]) => kind === 'updateUserById'), ['updateUserById', STUDENT_UUID, { password: STRONG_PASSWORD }]);
});

test('update-assignment: class checked in the database before the student ID is validated', async () => {
  const valid = { action: 'update-assignment', studentUserId: STUDENT_UUID, className: ' Class 12 ', section: ' B ' };
  assertError(await call({ ...valid, section: '' }), 400, 'Class and section are required', 'VALIDATION_FAILED');
  assertError(await call({ ...valid, className: 'x'.repeat(121) }), 400, 'Class and section are required', 'VALIDATION_FAILED');
  assertError(await call({ ...valid, studentUserId: 'bad', section: 'Z' }), 400, 'The selected class and section do not exist', 'VALIDATION_FAILED');
  assertError(await call({ ...valid, studentUserId: 'bad' }, { tables: { classes: () => ({ data: null, error: { code: 'XX' } }) } }),
    500, 'Failed to verify class and section', 'UNAVAILABLE');
  assertError(await call({ ...valid, studentUserId: 'bad' }), 400, 'A valid student user ID is required', 'VALIDATION_FAILED');

  const updated = await call(valid, { callerRpc: { admin_update_student_assignment: () => ({ data: { id: STUDENT_UUID, class: 'Class 12' }, error: null }) } });
  assert.equal(updated.status, 200);
  assert.deepEqual(updated.body, { id: STUDENT_UUID, class: 'Class 12' });
  assert.deepEqual(updated.calls.at(-1), ['caller.rpc', 'admin_update_student_assignment', {
    student_user_id_param: STUDENT_UUID, class_name_param: 'Class 12', section_param: 'B',
  }]);
  assert.deepEqual((await call(valid)).body, { id: STUDENT_UUID });
  assertError(await call(valid, { callerRpc: { admin_update_student_assignment: () => ({ data: null, error: { code: '42501' } }) } }),
    500, 'Failed to update student assignment', 'UNAVAILABLE');
});

test('create: validation order, duplicate detection, provisioning and rollback with correlation ID', async () => {
  const valid = { action: 'create', className: 'Class 12', section: 'A', studentId: 'STU.001', name: ' Grace ', password: STRONG_PASSWORD };
  const provisioned = { students: filters => ({ data: filters.id === NEW_USER_ID ? { id: NEW_USER_ID } : null, error: null }) };

  assertError(await call({ ...valid, studentId: 'x', section: 'Z' }), 400, 'The selected class and section do not exist', 'VALIDATION_FAILED');
  assertError(await call({ ...valid, studentId: 'x' }), 400, 'Student ID must be 2 to 64 letters, numbers, dots, underscores, or hyphens', 'VALIDATION_FAILED');
  assertError(await call({ ...valid, name: '' }), 400, 'Student name must be between 1 and 120 characters', 'VALIDATION_FAILED');
  assertError(await call({ ...valid, password: 'short' }), 400, 'Password must be between 12 and 128 characters', 'VALIDATION_FAILED');
  assertError(await call(valid, { tables: { students: () => ({ data: null, error: { code: 'XX' } }) } }), 500, 'Failed to verify student roster', 'UNAVAILABLE');
  assertError(await call(valid, { tables: { students: () => ({ data: { id: 'existing' }, error: null }) } }), 409, 'A student with this ID already exists', 'CONFLICT');
  assertError(await call(valid, { createUser: () => ({ data: null, error: { message: 'User already registered' } }) }), 409, 'A student with this ID already exists', 'CONFLICT');
  assertError(await call(valid, { createUser: () => ({ data: { user: null }, error: null }) }), 400, 'Failed to provision student account', 'VALIDATION_FAILED');

  const created = await call(valid, { tables: provisioned });
  assert.equal(created.status, 201);
  assert.deepEqual(created.body, { id: NEW_USER_ID, studentId: 'STU.001' });
  const [, attributes] = created.calls.find(([kind]) => kind === 'createUser');
  assert.deepEqual(attributes, {
    email: `stu.001@${STUDENT_EMAIL_DOMAIN}`,
    password: STRONG_PASSWORD,
    email_confirm: true,
    user_metadata: { student_id: 'STU.001', name: 'Grace', class: 'Class 12', section: 'A' },
    app_metadata: { provisioned_by: 'admin', provisioned_by_user: ADMIN_ID, account_type: 'student' },
  });
  assert.deepEqual(callNames(created.calls).slice(-3), ['createUser', 'admin.rpc:complete_account_provisioning', 'select:students']);

  const rolledBack = await call(valid, { adminRpc: { complete_account_provisioning: () => ({ data: null, error: { code: 'XX' } }) }, tables: provisioned });
  assertError(rolledBack, 500, 'Student provisioning failed during profile setup', 'UNAVAILABLE');
  assert.deepEqual(rolledBack.calls.at(-1), ['deleteUser', NEW_USER_ID]);

  const incomplete = await call(valid, { deleteUser: () => ({ error: new Error('down') }) });
  assertError(incomplete, 500, 'Student provisioning failed and user rollback was incomplete', 'UNAVAILABLE');
  const logged = quiet.lines.map(line => JSON.parse(line)).find(line => line.event === 'student_rollback_failed');
  assert.equal(logged.correlationId, incomplete.body.correlationId);

  assertError(await call(valid, { deleteUser: () => { throw new Error('network'); } }),
    500, 'Student provisioning failed and user rollback was incomplete', 'UNAVAILABLE');
});

test('structured log: one JSON shape per line and never passwords, tokens or bodies', async () => {
  const valid = { action: 'reset-student-password', studentUserId: STUDENT_UUID, password: STRONG_PASSWORD };
  await call(valid, { tables: { students: () => ({ data: { student_id: 'STU-1', archived_at: null }, error: null }) }, insert: () => ({ error: { code: 'x' } }) });
  await call({ action: 'create', className: 'Class 12', section: 'A', studentId: 'STU9', name: 'N', password: STRONG_PASSWORD }, { deleteUser: () => ({ error: new Error('x') }) });
  await call({ action: 'preview-reset' }, { root: true });
  assert.ok(quiet.lines.length >= 5);
  for (const line of quiet.lines) {
    const entry = JSON.parse(line);
    for (const key of ['level', 'event', 'correlationId', 'action', 'status']) assert.ok(key in entry, `${key} in ${line}`);
    assert.ok(!line.includes(STRONG_PASSWORD), 'password never logged');
    assert.ok(!line.includes('token-abc'), 'bearer token never logged');
  }
  const failure = quiet.lines.map(line => JSON.parse(line)).find(line => line.event === 'password_reset_audit_failed');
  assert.equal(failure.action, 'reset-student-password');
  assert.equal(failure.level, 'error');

  const lines = [];
  const sink = { log: line => lines.push(line), warn: line => lines.push(line), error: line => lines.push(line) };
  createLogger('create', sink).info('probe', { status: 200, password: 'secret-value', accessToken: 'abc', requestBody: '{}', kept: 1 });
  assert.deepEqual(JSON.parse(lines[0]), { level: 'info', event: 'probe', correlationId: null, action: 'create', status: 200, kept: 1 });
});
