import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('Stage 24 restores the named PostgREST contract for all exam-flow RPCs', async () => {
  const migration = await readFile(
    new URL('../supabase/migrations/20260913100000_stage24_restore_exam_rpc_parameter_names.sql', import.meta.url),
    'utf8'
  );

  assert.match(migration, /start_exam_session\(\s*exam_id_param[\s\S]*exam_data_param[\s\S]*responses_param/);
  assert.match(migration, /submit_exam\(\s*exam_id_param[\s\S]*responses_param/);
  assert.match(migration, /sync_active_session_progress\(\s*exam_id_param[\s\S]*responses_param[\s\S]*expected_version_param/);
  assert.match(migration, /terminate_exam\(exam_id_param/);
  assert.doesNotMatch(migration, /SET search_path = public/);

  for (const signature of [
    'public.start_exam_session(uuid, jsonb, jsonb)',
    'public.submit_exam(uuid, jsonb)',
    'public.sync_active_session_progress(uuid, jsonb, integer)',
    'public.terminate_exam(uuid)'
  ]) {
    assert.match(migration, new RegExp(`REVOKE ALL ON FUNCTION ${signature.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} FROM PUBLIC, anon`));
    assert.match(migration, new RegExp(`GRANT EXECUTE ON FUNCTION ${signature.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} TO authenticated`));
  }
});

test('offline recovery retains the exam title needed after a full browser reload', async () => {
  const [examLogic, app] = await Promise.all([
    readFile(new URL('../src/examLogic.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/App.jsx', import.meta.url), 'utf8')
  ]);

  assert.match(examLogic, /activeExam:\s*\{[\s\S]*id: examId,[\s\S]*title: examTitle\.trim\(\)/);
  assert.match(app, /examTitle:\s*activeExam\.title/);
});

test('the safety-critical offline overlay is bundled before the connection is lost', async () => {
  const app = await readFile(new URL('../src/App.jsx', import.meta.url), 'utf8');

  assert.match(app, /import OfflineOverlay from ['"]\.\/components\/OfflineOverlay['"]/);
  assert.doesNotMatch(app, /lazy\(\(\) => import\(['"]\.\/components\/OfflineOverlay['"]\)\)/);
});

test('browser logout is session-local so an old device cannot revoke a takeover session', async () => {
  const files = await Promise.all([
    readFile(new URL('../src/App.jsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/components/AuthPortal.jsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/components/AdminDashboard.jsx', import.meta.url), 'utf8')
  ]);

  const combined = files.join('\n');
  assert.match(combined, /auth\.signOut\(\{ scope: 'local' \}\)/);
  assert.doesNotMatch(combined, /auth\.signOut\(\)/);
});
