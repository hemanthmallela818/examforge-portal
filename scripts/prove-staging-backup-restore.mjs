// Read staging; restore only into a uniquely named database in the local container.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const projectRef = 'vjynyashxomyryqjfkas';
if (process.env.REHEARSAL_CONFIRM_DISPOSABLE !== 'YES_RESET_THIS_DISPOSABLE_PROJECT_AFTER_REHEARSAL') {
  throw new Error('Explicit staging confirmation is required.');
}
const container = 'supabase_db_MockTest-main';
const restoreDatabase = `cbt_staging_restore_${process.pid}_${Date.now()}`;
const temporaryDirectory = mkdtempSync(join(tmpdir(), 'cbt-staging-restore-'));
const remoteDirectory = `/tmp/${restoreDatabase}`;
let databaseCreated = false;
let phase = 'local container verification';
let failed = false;
const started = Date.now();
const run = (command, args) => {
  const result = spawnSync(command, args, {
    encoding: 'utf8', timeout: 300_000, maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, SUPABASE_TELEMETRY_DISABLED: '1', DO_NOT_TRACK: '1' }
  });
  // SQL failures can include INSERT data. Never relay raw stdout/stderr on failure.
  if (result.error || result.status !== 0) throw new Error(`Restore proof failed during ${phase}.`);
  return result.stdout.trim();
};
const cli = args => run(process.execPath, [resolve('node_modules/supabase/dist/supabase.js'), ...args]);
const docker = args => run('docker', args);
const tables = ['students', 'profiles', 'classes', 'cbt_exams_raw', 'cbt_exam_answers',
  'active_sessions', 'student_results', 'question_bank', 'question_import_batches',
  'import_history', 'admin_audit_events', 'exam_status_events'];
const summarySql = `select jsonb_object_agg(name, value) as summary from (${tables.map(table =>
  `select '${table}' as name, jsonb_build_object('count',count(*),'digest',md5(coalesce(string_agg(to_jsonb(t)::text,'' order by to_jsonb(t)::text),''))) as value from public.${table} t`
).join(' union all ')}) summaries;`;
const sourceSummary = () => JSON.parse(cli(['db', 'query', '--linked', '--project-ref', projectRef,
  '--output', 'json', summarySql])).rows[0].summary;
const summariesMatch = (left, right) => tables.every(table =>
  left[table]?.count === right[table]?.count && left[table]?.digest === right[table]?.digest);
const psql = args => docker(['exec', container, 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1',
  '--username', 'supabase_admin', '--dbname', restoreDatabase, ...args]);
try {
  if (docker(['inspect', '--format', '{{ index .Config.Labels "com.supabase.cli.project" }}', container]) !== 'MockTest-main') {
    throw new Error('Unexpected local database container.');
  }
  phase = 'source integrity snapshot';
  const before = sourceSummary();
  phase = 'staging schema export';
  cli(['db', 'dump', '--project-ref', projectRef, '--schema', 'public,auth,storage,extensions',
    '--file', join(temporaryDirectory, 'schema.sql')]);
  phase = 'staging data export';
  cli(['db', 'dump', '--project-ref', projectRef, '--schema', 'public,auth,storage', '--data-only', '--use-copy',
    '--file', join(temporaryDirectory, 'data.sql')]);
  phase = 'source stability verification';
  const after = sourceSummary();
  if (!summariesMatch(before, after)) throw new Error('Source changed during export; retry without active writers.');
  const restoreStarted = Date.now();
  phase = 'isolated database creation';
  docker(['exec', container, 'createdb', '--username=supabase_admin', '--template=template0', restoreDatabase]);
  databaseCreated = true;
  docker(['exec', container, 'mkdir', remoteDirectory]);
  docker(['cp', `${temporaryDirectory}/.`, `${container}:${remoteDirectory}`]);
  phase = 'schema restoration';
  psql(['--file', `${remoteDirectory}/schema.sql`]);
  phase = 'data restoration';
  psql(['--command', 'SET session_replication_role = replica;', '--file', `${remoteDirectory}/data.sql`]);
  phase = 'restored integrity comparison';
  const restored = JSON.parse(psql(['--command', summarySql]));
  if (!summariesMatch(before, restored)) {
    console.error(JSON.stringify({ mismatchedTables: tables.filter(table =>
      before[table]?.count !== restored[table]?.count || before[table]?.digest !== restored[table]?.digest) }));
    throw new Error('Restored public data does not match staging.');
  }
  phase = 'restored constraint verification';
  const invalidConstraints = Number(psql(['--command', "select count(*) from pg_constraint where connamespace='public'::regnamespace and not convalidated;"]));
  if (invalidConstraints !== 0) throw new Error('Unvalidated constraints found in restored data.');
  console.log(JSON.stringify({ status: 'STAGING_LOGICAL_RESTORE_VERIFIED', projectRef,
    restoredPublicTables: tables.length, restoredResults: restored.student_results.count,
    sourceStable: true, publicDataDigestsMatch: true, unvalidatedPublicConstraints: invalidConstraints,
    totalMilliseconds: Date.now() - started, restoreAndVerificationMilliseconds: Date.now() - restoreStarted,
    scope: 'Logical schema/data restore into isolated local database; not hosted disaster recovery or PITR.'
  }));
} catch {
  console.error(`Staging restore proof failed during ${phase}; sensitive database output was suppressed.`);
  failed = true;
} finally {
  phase = 'temporary database cleanup';
  try {
    if (databaseCreated) docker(['exec', container, 'dropdb', '--if-exists', '--force', '--username=supabase_admin', restoreDatabase]);
    // Both paths are generated exclusively by this script, not caller input.
    docker(['exec', container, 'rm', '-rf', '--', remoteDirectory]);
  } catch { console.error('Temporary local restore cleanup needs investigation.'); failed = true; }
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
process.exitCode = failed ? 1 : 0;
