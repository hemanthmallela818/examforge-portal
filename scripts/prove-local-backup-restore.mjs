#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const projectConfig = readFileSync(resolve('supabase/config.toml'), 'utf8');
const projectId = projectConfig.match(/^project_id\s*=\s*"([A-Za-z0-9_-]+)"\s*$/m)?.[1];
if (!projectId) throw new Error('Unable to determine the local Supabase project id.');

const container = `supabase_db_${projectId}`;
const restoreUser = 'supabase_admin';
const restoreDatabase = `cbt_restore_proof_${process.pid}_${Date.now()}`;
const dumpPath = `/tmp/${restoreDatabase}.dump`;

if (!/^cbt_restore_proof_[0-9]+_[0-9]+$/.test(restoreDatabase)) {
  throw new Error('Unsafe restore verification database name.');
}

const docker = (args, options = {}) => execFileSync('docker', args, {
  cwd: process.cwd(),
  encoding: 'utf8',
  stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit'
});

const summarySql = `
WITH summaries AS (
  SELECT 'students' AS relation,
         count(*)::bigint AS row_count,
         md5(coalesce(string_agg(row_to_json(t)::text, '' ORDER BY t.id::text), '')) AS digest
    FROM public.students t
  UNION ALL
  SELECT 'classes', count(*)::bigint,
         md5(coalesce(string_agg(row_to_json(t)::text, '' ORDER BY t.id::text), ''))
    FROM public.classes t
  UNION ALL
  SELECT 'question_bank', count(*)::bigint,
         md5(coalesce(string_agg(row_to_json(t)::text, '' ORDER BY t.id::text), ''))
    FROM public.question_bank t
  UNION ALL
  SELECT 'cbt_exams', count(*)::bigint,
         md5(coalesce(string_agg(row_to_json(t)::text, '' ORDER BY t.id::text), ''))
    FROM public.cbt_exams t
  UNION ALL
  SELECT 'active_sessions', count(*)::bigint,
         md5(coalesce(string_agg(row_to_json(t)::text, '' ORDER BY t.id::text), ''))
    FROM public.active_sessions t
  UNION ALL
  SELECT 'student_results', count(*)::bigint,
         md5(coalesce(string_agg(row_to_json(t)::text, '' ORDER BY t.id::text), ''))
    FROM public.student_results t
)
SELECT jsonb_object_agg(relation, jsonb_build_object('count', row_count, 'digest', digest))::text
  FROM summaries;
`;

const databaseSummary = database => JSON.parse(docker([
  'exec', container,
  'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1',
  '--username', restoreUser, '--dbname', database,
  '--command', summarySql
], { capture: true }).trim());

let restoreCreated = false;
try {
  const running = docker(['inspect', '--format', '{{.State.Running}}', container], { capture: true }).trim();
  const label = docker([
    'inspect', '--format', '{{ index .Config.Labels "com.supabase.cli.project" }}', container
  ], { capture: true }).trim();
  if (running !== 'true' || label !== projectId) {
    throw new Error('The expected local Supabase database container is not running.');
  }

  const source = databaseSummary('postgres');
  docker([
    'exec', container,
    'pg_dump', '--format=custom', `--username=${restoreUser}`, '--dbname=postgres', `--file=${dumpPath}`
  ]);
  docker([
    'exec', container,
    'createdb', `--username=${restoreUser}`, '--template=template0', restoreDatabase
  ]);
  restoreCreated = true;
  docker([
    'exec', container,
    'pg_restore', '--exit-on-error', '--no-owner', '--no-privileges',
    `--username=${restoreUser}`, `--dbname=${restoreDatabase}`, dumpPath
  ]);

  const restored = databaseSummary(restoreDatabase);
  if (JSON.stringify(restored) !== JSON.stringify(source)) {
    throw new Error(`Restored database verification mismatch: ${JSON.stringify({ source, restored })}`);
  }

  const invalidConstraints = Number(docker([
    'exec', container,
    'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1',
    '--username', restoreUser, '--dbname', restoreDatabase,
    '--command', "SELECT count(*) FROM pg_constraint WHERE connamespace = 'public'::regnamespace AND NOT convalidated;"
  ], { capture: true }).trim());
  if (invalidConstraints !== 0) throw new Error(`Restored database has ${invalidConstraints} unvalidated constraints.`);

  console.log(JSON.stringify({
    status: 'RESTORE_VERIFIED',
    sourceDatabase: 'local/postgres',
    restoredRelations: source,
    unvalidatedPublicConstraints: invalidConstraints
  }, null, 2));
} finally {
  if (restoreCreated) {
    docker(['exec', container, 'dropdb', '--if-exists', '--force', `--username=${restoreUser}`, restoreDatabase]);
  }
  docker(['exec', container, 'rm', '-f', '--', dumpPath]);
}
