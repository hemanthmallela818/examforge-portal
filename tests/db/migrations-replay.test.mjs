import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { applyMigrations, createStubbedPglite, createTestDb, listMigrations } from './harness.mjs';

let h;
let durationMs;

before(async () => {
  const startedAt = Date.now();
  h = await createTestDb();
  durationMs = Date.now() - startedAt;
});

after(async () => {
  await h?.close();
});

test('every migration replays cleanly, in order, from an empty database', () => {
  const files = listMigrations();
  assert.ok(files.length >= 77, `expected at least 77 migrations, found ${files.length}`);
  assert.deepEqual(h.applied, files);
  assert.deepEqual([...files].sort(), files, 'filenames sort chronologically');
  assert.equal(new Set(files.map((f) => f.slice(0, 14))).size, files.length, 'migration versions are unique');
  const warnings = h.notices.filter((n) => n.severity === 'WARNING');
  assert.deepEqual(warnings, [], 'no migration emitted a WARNING');
  assert.ok(durationMs < 60_000, `replay took ${durationMs}ms`);
});

test('pg_cron is absent in PGlite, so the scheduler migration takes its documented fallback branch', async () => {
  assert.ok(
    h.notices.some((n) => /pg_cron is not available/.test(n.message)),
    'the pg_cron DO-block emitted its fallback NOTICE'
  );
  const su = await h.asSuperuser();
  assert.equal(await su.value(`SELECT to_regnamespace('cron') IS NULL`), true);
});

test('latest schema objects exist after replay', async () => {
  const su = await h.asSuperuser();
  const functions = [
    'public.submit_exam(uuid,jsonb,integer)',
    'public.sync_active_session_progress(uuid,jsonb,integer)',
    'public.finalize_expired_sessions_internal(integer,integer,uuid,text)',
    'public.run_scheduled_session_finalization()',
    'public.admin_finalize_expired_sessions(integer)',
    'public.admin_clear_question_bank(text)',
    'public.root_reset_application_data_for_actor(uuid,text)',
    'public.admin_save_subject(uuid,text,boolean)',
    'public.admin_save_exam_template(uuid,text,text,integer,numeric,numeric,jsonb,boolean)',
    'public.preflight_validate_exam(uuid)'
  ];
  for (const signature of functions) {
    assert.ok(await su.value('SELECT to_regprocedure($1) IS NOT NULL', [signature]), `${signature} exists`);
  }
  // The legacy 2-argument submit_exam overload was folded into the versioned one.
  assert.equal(await su.value(`SELECT count(*)::int FROM pg_proc WHERE proname = 'submit_exam' AND pronamespace = 'public'::regnamespace`), 1);
  for (const table of ['subjects', 'exam_templates', 'application_owner', 'managed_administrators', 'student_result_reviews']) {
    assert.ok(await su.value('SELECT to_regclass($1) IS NOT NULL', [`public.${table}`]), `${table} exists`);
  }
});

test('database-wide invariants hold after replay', async () => {
  const su = await h.asSuperuser();

  // Every SECURITY DEFINER function in public pins its search_path.
  const unpinned = await su.rows(`
    SELECT p.oid::regprocedure::text AS sig
    FROM pg_proc p
    WHERE p.pronamespace = 'public'::regnamespace AND p.prosecdef
      AND NOT EXISTS (SELECT 1 FROM unnest(coalesce(p.proconfig, '{}')) c WHERE c LIKE 'search_path=%')`);
  assert.deepEqual(unpinned, []);

  // Every public table has RLS enabled.
  const withoutRls = await su.rows(`
    SELECT relname FROM pg_class
    WHERE relnamespace = 'public'::regnamespace AND relkind = 'r' AND NOT relrowsecurity`);
  assert.deepEqual(withoutRls, []);

  // anon can execute nothing in public except the public login-page branding.
  const anonExecutable = await su.rows(`
    SELECT p.oid::regprocedure::text AS sig FROM pg_proc p
    WHERE p.pronamespace = 'public'::regnamespace
      AND p.prokind = 'f'
      AND p.proname NOT LIKE 'uuid\\_%'
      AND has_function_privilege('anon', p.oid, 'EXECUTE')`);
  assert.deepEqual(anonExecutable.map((r) => r.sig), ['get_public_branding()']);

  // Realtime publishes only the safe exam status surface.
  const published = (await su.rows(`
    SELECT schemaname || '.' || tablename AS t FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' ORDER BY 1`)).map((r) => r.t);
  assert.ok(published.includes('public.exam_status_events'));
  assert.ok(!published.includes('public.cbt_exams_raw'));
  assert.ok(!published.includes('public.cbt_exam_answers'));

  // ALTER ROLE ... SET from the hot-path migration is applied.
  const roleSettings = await su.value(`
    SELECT setconfig FROM pg_db_role_setting WHERE setrole = 'authenticated'::regrole`);
  assert.ok(roleSettings.includes('lock_timeout=5s'), `authenticated settings: ${roleSettings}`);
});

test('the harness fails loudly, naming the migration, when one cannot be applied', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'examforge-bad-migrations-'));
  const db = await createStubbedPglite();
  try {
    writeFileSync(join(dir, '20990101000000_ok.sql'), 'CREATE TABLE public.harness_probe (id int);');
    writeFileSync(join(dir, '20990101000001_broken.sql'), 'ALTER TABLE public.missing_table ADD COLUMN x int;');
    writeFileSync(join(dir, '20990101000002_never_reached.sql'), 'CREATE TABLE public.never_reached (id int);');
    await assert.rejects(
      applyMigrations(db, { dir: pathToFileURL(`${dir}/`) }),
      /Migration 20990101000001_broken\.sql failed: relation "public\.missing_table" does not exist/
    );
    assert.equal((await db.query(`SELECT to_regclass('public.never_reached') IS NULL AS missing`)).rows[0].missing, true);
  } finally {
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
