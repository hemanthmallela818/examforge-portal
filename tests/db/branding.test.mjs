import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, ROOT_ID } from './harness.mjs';

const LOGO = 'logo-0f8fad5b-d9cb-469f-a165-70867728950e.png';
const OTHER_LOGO = 'logo-7c9e6679-7425-40de-944b-e07fc1f90ae7.webp';

let h;
before(async () => {
  h = await createTestDb();
  await h.seedAdministrators();
  const su = await h.asSuperuser();
  await su.query(
    `INSERT INTO storage.objects (bucket_id, name) VALUES ('branding', $1), ('branding', $2), ('exam-assets', 'logo-11111111-1111-4111-8111-111111111111.png')`,
    [LOGO, OTHER_LOGO]
  );
});
after(async () => { await h?.close(); });

test('defaults: the singleton exists and anon/students read only name, colour and logo', async () => {
  const anon = await h.asAnon();
  const branding = await anon.value('SELECT public.get_public_branding()');
  assert.deepEqual(Object.keys(branding).sort(), ['institution_name', 'logo_path', 'logo_url', 'primary_color', 'updated_at']);
  assert.equal(branding.institution_name, null);
  assert.equal(branding.primary_color, null);
  assert.equal(branding.logo_url, null);

  const student = await h.createStudent({ studentId: 'BR-1' });
  const s = await h.asStudent(student.id, student.sessionId);
  assert.equal((await s.value('SELECT public.get_public_branding()')).institution_name, null);

  const su = await h.asSuperuser();
  assert.equal(await su.value('SELECT count(*)::int FROM public.institution_branding'), 1);
  await assert.rejects(su.query('INSERT INTO public.institution_branding (id) VALUES (false)'), /check constraint/);
});

test('the table has no direct read or write access for anon, students or administrators', async () => {
  const anon = await h.asAnon();
  await assert.rejects(anon.query('SELECT * FROM public.institution_branding'), /permission denied/);
  const admin = await h.asAdmin();
  await assert.rejects(admin.query('SELECT * FROM public.institution_branding'), /permission denied/);
  await assert.rejects(admin.query(`UPDATE public.institution_branding SET institution_name = 'X'`), /permission denied/);
  const root = await h.asRoot();
  await assert.rejects(root.query(`UPDATE public.institution_branding SET institution_name = 'X'`), /permission denied/);
});

test('only the root developer can update branding', async () => {
  const anon = await h.asAnon();
  await assert.rejects(anon.query(`SELECT public.root_update_branding('X', '#123456', NULL)`), /permission denied/);
  const admin = await h.asAdmin();
  await assert.rejects(admin.query(`SELECT public.root_update_branding('X', '#123456', NULL)`), /Root developer access is required/);
  const student = await h.createStudent({ studentId: 'BR-2' });
  const s = await h.asStudent(student.id, student.sessionId);
  await assert.rejects(s.query(`SELECT public.root_update_branding('X', '#123456', NULL)`), /Root developer access is required/);
});

test('root updates are normalised, validated, visible publicly and audited', async () => {
  const root = await h.asRoot();
  const saved = await root.value(
    'SELECT public.root_update_branding($1, $2, $3)',
    ['  Sunrise   Public School ', ' #0F766E ', LOGO]
  );
  assert.equal(saved.institution_name, 'Sunrise Public School');
  assert.equal(saved.primary_color, '#0f766e');
  assert.equal(saved.logo_path, LOGO);
  assert.equal(saved.logo_url, `/storage/v1/object/public/branding/${LOGO}`);

  const anon = await h.asAnon();
  assert.equal((await anon.value('SELECT public.get_public_branding()')).institution_name, 'Sunrise Public School');

  const su = await h.asSuperuser();
  const [event] = await su.rows(
    `SELECT actor_user_id, target_type, metadata FROM public.admin_audit_events WHERE action = 'UPDATE_BRANDING' ORDER BY occurred_at DESC LIMIT 1`
  );
  assert.equal(event.actor_user_id, ROOT_ID);
  assert.equal(event.target_type, 'institution_branding');
  assert.equal(event.metadata.primary_color, '#0f766e');
  assert.equal(event.metadata.logo_changed, true);
  assert.equal(event.metadata.reset_to_defaults, false);

  // The root developer (an administrator) can read the audit trail too.
  const count = await root.value(`SELECT count(*)::int FROM public.admin_audit_events WHERE action = 'UPDATE_BRANDING'`);
  assert.ok(count >= 1);
});

test('invalid names, colours and logo paths are rejected without changing the branding', async () => {
  const root = await h.asRoot();
  const cases = [
    [['x'.repeat(81), '#123456', null], /Institution name must be 1 to 80/],
    [['Bad\u0007Name', '#123456', null], /Institution name must be 1 to 80/],
    [['School', 'red', null], /#RRGGBB/],
    [['School', '#12345', null], /#RRGGBB/],
    [['School', '#1234567', null], /#RRGGBB/],
    [['School', '#123456', '../exam-assets/secret.png'], /not a branding logo/],
    [['School', '#123456', 'logo.svg'], /not a branding logo/],
    // A valid name that is not in the branding bucket (it lives in exam-assets).
    [['School', '#123456', 'logo-11111111-1111-4111-8111-111111111111.png'], /not found in the branding bucket/]
  ];
  for (const [params, pattern] of cases) {
    await assert.rejects(root.query('SELECT public.root_update_branding($1, $2, $3)', params), pattern, JSON.stringify(params));
  }
  const anon = await h.asAnon();
  const branding = await anon.value('SELECT public.get_public_branding()');
  assert.equal(branding.institution_name, 'Sunrise Public School');
  assert.equal(branding.primary_color, '#0f766e');
});

test('changing the logo and resetting to defaults are audited', async () => {
  const root = await h.asRoot();
  const changed = await root.value('SELECT public.root_update_branding($1, $2, $3)', ['Sunrise Public School', '#0f766e', OTHER_LOGO]);
  assert.equal(changed.logo_path, OTHER_LOGO);

  const reset = await root.value('SELECT public.root_update_branding(NULL, NULL, NULL)');
  assert.equal(reset.institution_name, null);
  assert.equal(reset.primary_color, null);
  assert.equal(reset.logo_path, null);

  // Blank strings also mean "default".
  const blank = await root.value(`SELECT public.root_update_branding('   ', '', '')`);
  assert.equal(blank.institution_name, null);

  const su = await h.asSuperuser();
  const events = await su.rows(
    `SELECT metadata FROM public.admin_audit_events WHERE action = 'UPDATE_BRANDING' ORDER BY occurred_at`
  );
  const resetEvent = events.find(event => event.metadata.reset_to_defaults === true);
  assert.ok(resetEvent, 'a reset event was recorded');
  assert.equal(resetEvent.metadata.previous_logo_path, OTHER_LOGO);
});

test('the branding bucket is public, size and type limited, and writable only by the root developer', async () => {
  const su = await h.asSuperuser();
  const [bucket] = await su.rows(`SELECT public, file_size_limit, allowed_mime_types FROM storage.buckets WHERE id = 'branding'`);
  assert.equal(bucket.public, true);
  assert.equal(Number(bucket.file_size_limit), 1048576);
  assert.deepEqual(bucket.allowed_mime_types, ['image/png', 'image/webp']);

  const name = 'logo-9b2f6c1e-3d4a-4b5c-8d6e-7f8091a2b3c4.png';
  const admin = await h.asAdmin();
  await assert.rejects(
    admin.query(`INSERT INTO storage.objects (bucket_id, name) VALUES ('branding', $1)`, [name]),
    /row-level security/
  );
  const root = await h.asRoot();
  await assert.rejects(
    root.query(`INSERT INTO storage.objects (bucket_id, name) VALUES ('branding', 'logo.svg')`),
    /row-level security/
  );
  await root.query(`INSERT INTO storage.objects (bucket_id, name) VALUES ('branding', $1)`, [name]);
  // Administrators cannot list or delete branding objects; anon cannot list.
  assert.equal(await admin.value(`SELECT count(*)::int FROM storage.objects WHERE bucket_id = 'branding'`), 0);
  const anon = await h.asAnon();
  assert.equal(await anon.value(`SELECT count(*)::int FROM storage.objects WHERE bucket_id = 'branding'`), 0);
  await admin.query(`DELETE FROM storage.objects WHERE bucket_id = 'branding' AND name = $1`, [name]);
  assert.equal(await su.value(`SELECT count(*)::int FROM storage.objects WHERE name = $1`, [name]), 1);
  await root.query(`DELETE FROM storage.objects WHERE bucket_id = 'branding' AND name = $1`, [name]);
  assert.equal(await su.value(`SELECT count(*)::int FROM storage.objects WHERE name = $1`, [name]), 0);
});
