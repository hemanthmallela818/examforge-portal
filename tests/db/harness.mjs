// Database test harness: replays EVERY migration in supabase/migrations against
// an in-process PGlite (real PostgreSQL compiled to WASM) so behavioural tests
// exercise the latest function / policy / trigger definitions exactly as the
// migration chain produces them.
//
// Supabase-provided objects that the migrations assume already exist are
// installed as explicit stubs in SUPABASE_STUBS below. No migration SQL is
// rewritten or skipped; if a migration fails, applyMigrations() throws with the
// file name so regressions are caught immediately.
//
// Platform features and how each is handled:
// - CREATE EXTENSION "uuid-ossp": real extension, loaded from PGlite contrib.
// - pg_cron (20260924130000): not in pg_available_extensions, so the
//   migration's own guarded DO-block takes its NOTICE fallback branch. The
//   finalization tests execute the exact scheduled command instead.
// - ALTER ROLE authenticated SET lock_timeout: supported natively once the
//   roles exist (stubbed below).
// - ALTER PUBLICATION supabase_realtime: the publication is stubbed below.
// - storage.objects / storage.buckets, auth.users / auth.identities,
//   auth.jwt() / auth.uid() / auth.role(): stubbed below.
// - pg_has_role(current_user, 'supabase_admin', ...): role stubbed; postgres is
//   not a member, matching hosted Supabase.
//
// Note: PGlite runs as the superuser "postgres". SECURITY DEFINER functions
// therefore run as a superuser (as on Supabase, where postgres owns them), and
// every test identity other than asSuperuser() uses SET ROLE so grants and RLS
// are enforced.
import { readdirSync, readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { uuid_ossp } from '@electric-sql/pglite/contrib/uuid_ossp';

export const MIGRATIONS_DIR = new URL('../../supabase/migrations/', import.meta.url);

export function listMigrations(dir = MIGRATIONS_DIR) {
  return readdirSync(dir).filter((name) => name.endsWith('.sql')).sort();
}

// Stubs for everything Supabase provisions before application migrations run.
// Each block documents what it stands in for.
export const SUPABASE_STUBS = `
  -- Supabase API roles. supabase_admin exists on the platform (the application
  -- migration role is NOT a member, which 20260912103030 checks via pg_has_role).
  CREATE ROLE anon NOLOGIN;
  CREATE ROLE authenticated NOLOGIN;
  CREATE ROLE service_role NOLOGIN BYPASSRLS;
  CREATE ROLE supabase_admin NOLOGIN;

  -- GoTrue schema: only the columns migrations and tests touch.
  CREATE SCHEMA auth;
  GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
  CREATE TABLE auth.users (
    id uuid PRIMARY KEY,
    email text,
    raw_app_meta_data jsonb NOT NULL DEFAULT '{}'::jsonb,
    raw_user_meta_data jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  );
  -- GoTrue sign-in identities (email provider); 20260925090000 rewrites them.
  CREATE TABLE auth.identities (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    provider_id text NOT NULL,
    user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    identity_data jsonb NOT NULL,
    provider text NOT NULL,
    created_at timestamptz DEFAULT now(),
    updated_at timestamptz DEFAULT now(),
    UNIQUE (provider_id, provider)
  );

  -- auth.jwt()/uid()/role() read PostgREST request settings exactly as the
  -- Supabase implementations do (request.jwt.claims first, then the legacy
  -- per-claim request.jwt.claim.* settings).
  CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$
    SELECT COALESCE(
      NULLIF(current_setting('request.jwt.claims', true), ''),
      '{}'
    )::jsonb
  $$;
  CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
    SELECT COALESCE(
      NULLIF(current_setting('request.jwt.claim.sub', true), ''),
      NULLIF(auth.jwt() ->> 'sub', '')
    )::uuid
  $$;
  CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$
    SELECT COALESCE(
      NULLIF(current_setting('request.jwt.claim.role', true), ''),
      NULLIF(auth.jwt() ->> 'role', '')
    )::text
  $$;
  GRANT EXECUTE ON FUNCTION auth.jwt(), auth.uid(), auth.role()
    TO anon, authenticated, service_role;

  -- Supabase Storage schema (bucket + object metadata only).
  CREATE SCHEMA storage;
  GRANT USAGE ON SCHEMA storage TO anon, authenticated, service_role;
  CREATE TABLE storage.buckets (
    id text PRIMARY KEY,
    name text NOT NULL,
    public boolean DEFAULT false,
    file_size_limit bigint,
    allowed_mime_types text[],
    created_at timestamptz DEFAULT now()
  );
  CREATE TABLE storage.objects (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    bucket_id text REFERENCES storage.buckets(id),
    name text,
    owner uuid,
    metadata jsonb,
    created_at timestamptz DEFAULT now(),
    updated_at timestamptz DEFAULT now()
  );
  ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
  GRANT ALL ON storage.objects, storage.buckets TO anon, authenticated, service_role;

  -- Supabase Realtime publication (logical replication catalog entry only).
  CREATE PUBLICATION supabase_realtime;
`;

/**
 * Applies every migration in filename order. Server NOTICE/WARNING messages
 * are collected per file (e.g. the pg_cron fallback notice). Any failure
 * aborts with the migration file name so regressions surface immediately.
 */
export async function applyMigrations(db, { dir = MIGRATIONS_DIR } = {}) {
  const applied = [];
  const notices = [];
  for (const file of listMigrations(dir)) {
    const sql = readFileSync(new URL(file, dir), 'utf8');
    try {
      await db.exec(sql, {
        onNotice: (notice) => notices.push({ file, severity: notice.severity, message: notice.message })
      });
    } catch (error) {
      throw new Error(`Migration ${file} failed: ${error.message}`, { cause: error });
    }
    applied.push(file);
  }
  return { applied, notices };
}

// ---------------------------------------------------------------------------
// Identity switching. PGlite is a single connection, so every helper first
// resets to the migration owner (postgres, superuser) and clears all request
// claims before assuming the next identity. This mirrors what PostgREST does
// per request: SET LOCAL ROLE <jwt role> plus request.jwt.claims.
// ---------------------------------------------------------------------------

export const ROOT_ID = '00000000-0000-4000-8000-00000000a001';
export const ADMIN_ID = '00000000-0000-4000-8000-00000000a002';
export const SCHEDULER_ACTOR_ID = '00000000-0000-0000-0000-000000000000';

let uuidCounter = 0;
/** Deterministic, valid v4-shaped UUIDs for test data. */
export function testUuid(prefix = 'b') {
  uuidCounter += 1;
  return `00000000-0000-4000-8000-${prefix}${String(uuidCounter).padStart(11, '0')}`;
}

// A session handle is bound to one identity: every call re-assumes that
// identity first, so interleaving handles (e.g. a superuser check between two
// student calls) can never leak a role or claims into the wrong request.
function sessionHandle(db, identity) {
  const run = async (sql, params) => {
    await applyIdentity(db, identity);
    return db.query(sql, params);
  };
  return {
    db,
    identity,
    query: run,
    rows: async (sql, params) => (await run(sql, params)).rows,
    /** First column of the first row (or undefined). */
    value: async (sql, params) => {
      const { rows, fields } = await run(sql, params);
      return rows.length ? rows[0][fields[0].name] : undefined;
    }
  };
}

async function applyIdentity(db, { role, claims }) {
  await db.exec('RESET ROLE');
  await db.query(
    `SELECT set_config('request.jwt.claims', $1, false),
            set_config('request.jwt.claim.sub', '', false),
            set_config('request.jwt.claim.role', '', false)`,
    [claims ? JSON.stringify(claims) : '']
  );
  if (role) await db.exec(`SET ROLE ${role}`);
}

async function assumeIdentity(db, identity) {
  await applyIdentity(db, identity);
  return sessionHandle(db, identity);
}

export class TestDb {
  constructor(db, { applied, notices }) {
    this.db = db;
    this.applied = applied;
    this.notices = notices;
  }

  /** Migration owner / pg_cron context: superuser, no JWT. */
  asSuperuser() {
    return assumeIdentity(this.db, {});
  }

  /** PostgREST service_role request (Edge Functions). */
  asService() {
    return assumeIdentity(this.db, { role: 'service_role', claims: { role: 'service_role' } });
  }

  asAnon() {
    return assumeIdentity(this.db, { role: 'anon', claims: { role: 'anon' } });
  }

  /** Authenticated user with arbitrary claims (admins use AAL2). */
  asUser(userId, { sessionId = testUuid('c'), aal = 'aal2' } = {}) {
    return assumeIdentity(this.db, {
      role: 'authenticated',
      claims: { sub: userId, role: 'authenticated', aal, session_id: sessionId }
    });
  }

  asRoot(rootId = ROOT_ID) {
    return this.asUser(rootId);
  }

  asAdmin(adminId = ADMIN_ID) {
    return this.asUser(adminId);
  }

  asStudent(studentUuid, sessionId) {
    if (!sessionId) throw new Error('asStudent requires the auth session id');
    return this.asUser(studentUuid, { sessionId, aal: 'aal1' });
  }

  async close() {
    await this.db.close();
  }

  // -------------------------------------------------------------------------
  // Seeding. Accounts go through auth.users so the real on_auth_user_created
  // trigger (handle_new_user) creates profiles/students exactly like the
  // manage-student / manage-admin Edge Functions do.
  // -------------------------------------------------------------------------

  async createAuthUser({ id = testUuid('d'), email, accountType, metadata = {} }) {
    const su = await this.asSuperuser();
    await su.query(
      `INSERT INTO auth.users (id, email, raw_app_meta_data, raw_user_meta_data)
       VALUES ($1, $2, $3, $4)`,
      [id, email, { provisioned_by: 'admin', account_type: accountType }, metadata]
    );
    return id;
  }

  /** Root owner (application_owner singleton) + one managed administrator. */
  async seedAdministrators({ rootId = ROOT_ID, adminId = ADMIN_ID } = {}) {
    await this.createAuthUser({ id: rootId, email: 'root@examforge.test', accountType: 'admin', metadata: { name: 'Root Owner' } });
    const su = await this.asSuperuser();
    await su.query('INSERT INTO public.application_owner (user_id) VALUES ($1)', [rootId]);
    await this.createAuthUser({ id: adminId, email: 'admin@examforge.test', accountType: 'admin', metadata: { name: 'Managed Admin' } });
    const svc = await this.asService();
    await svc.query('SELECT public.register_managed_administrator($1, $2)', [adminId, rootId]);
    return { rootId, adminId };
  }

  async createClass(name, sections = ['A']) {
    const admin = await this.asAdmin();
    await admin.query('INSERT INTO public.classes (name, sections) VALUES ($1, $2)', [name, sections]);
  }

  /**
   * Provisions a student and claims an auth session for them (sets
   * students.active_auth_session_id through claim_student_session()).
   */
  async createStudent({ studentId, name = `Student ${studentId}`, className = '12', section = 'A', sessionId = testUuid('e') }) {
    const id = await this.createAuthUser({
      email: `${studentId.toLowerCase()}@students.examforge.invalid`,
      accountType: 'student',
      metadata: { student_id: studentId, name, class: className, section }
    });
    const student = await this.asStudent(id, sessionId);
    await student.query('SELECT public.claim_student_session()');
    return { id, studentId, name, sessionId };
  }

  /**
   * Creates an exam the same way the admin UI does: INSERT into the
   * public.cbt_exams view (INSTEAD OF trigger strips answers into
   * cbt_exam_answers and runs preflight when ACTIVE).
   */
  async createExam({
    title = `Exam ${testUuid('f')}`,
    status = 'ACTIVE',
    className = '12',
    section = 'A',
    duration = 60,
    marksCorrect = 4,
    marksIncorrect = -1,
    paper = defaultPaper()
  } = {}) {
    const admin = await this.asAdmin();
    const questionsData = {
      duration,
      marksCorrect,
      marksIncorrect,
      subjects: Object.keys(paper),
      questions: paper
    };
    return admin.value(
      `INSERT INTO public.cbt_exams (title, status, class, section, questions_data)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [title, status, className, section, questionsData]
    );
  }
}

/** Two MCQs (Physics) + one numerical (Mathematics). */
export function defaultPaper() {
  return {
    Physics: [
      { id: 'phy-1', type: 'MCQ', text: 'Unit of force?', options: ['Joule', 'Newton', 'Watt', 'Pascal'], correctAnswer: 'B' },
      { id: 'phy-2', type: 'MCQ', text: 'Unit of power?', options: ['Joule', 'Newton', 'Watt', 'Pascal'], correctAnswer: '2' }
    ],
    Mathematics: [
      { id: 'math-1', type: 'NUMERICAL', text: 'Half of 5?', options: [], correctAnswer: '2.5' }
    ]
  };
}

/** Correct answers for defaultPaper(), keyed by question id. */
export const DEFAULT_CORRECT = { 'phy-1': '1', 'phy-2': '2', 'math-1': '2.5' };

/**
 * Builds the autosave progress object ({ subject: [{selectedOption,status}] })
 * aligned to the server-shuffled paper returned by start_exam_session.
 */
export function buildProgress(jumbledExamData, answersById) {
  const progress = {};
  for (const [subject, questions] of Object.entries(jumbledExamData.questions)) {
    progress[subject] = questions.map((question) => {
      const answer = answersById[question.id];
      return answer === undefined
        ? { selectedOption: null, status: 'NOT_VISITED' }
        : { selectedOption: answer, status: 'ANSWERED' };
    });
  }
  return progress;
}

/** Builds the submit_exam payload ([{question_id, selected_option, status}]). */
export function buildSubmission(answersById) {
  return Object.entries(answersById).map(([questionId, answer]) => ({
    question_id: questionId,
    selected_option: answer,
    status: 'ANSWERED'
  }));
}

/** A fresh PGlite with the Supabase stubs installed but no migrations. */
export async function createStubbedPglite() {
  const db = new PGlite({ extensions: { uuid_ossp } });
  await db.exec(SUPABASE_STUBS);
  return db;
}

/** Replays every migration into a fresh in-memory database. */
export async function createTestDb() {
  const db = await createStubbedPglite();
  const migrationRun = await applyMigrations(db);
  return new TestDb(db, migrationRun);
}
