import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, testUuid } from './harness.mjs';

let h;

before(async () => {
  h = await createTestDb();
  await h.seedAdministrators();
  await h.createClass('12', ['A']);
});

after(async () => {
  await h?.close();
});

const OPTIONS = ['Alpha', 'Beta', 'Gamma', 'Delta'];
const LISTS = { left: ['Force', 'Power'], right: ['Newton', 'Watt', 'Joule'] };
let textCounter = 0;
const uniqueText = (label) => `${label} ${++textCounter}`;

async function insertQuestion({ type, text = uniqueText(type), options = OPTIONS, answer, details = null, subject = 'Physics' }) {
  const admin = await h.asAdmin();
  return admin.value(
    `INSERT INTO public.question_bank (subject, type, question_text, options, correct_answer, details)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6::jsonb) RETURNING id`,
    [subject, type, text, JSON.stringify(options), answer, details === null ? null : JSON.stringify(details)]
  );
}

async function bankPage(type) {
  const admin = await h.asAdmin();
  return admin.value('SELECT public.get_admin_question_bank_page(0, 200, NULL, NULL, $1)', [type]);
}

test('the bank stores every new question type', async () => {
  assert.ok(await insertQuestion({ type: 'MULTIPLE_CORRECT', answer: '0,2' }));
  assert.ok(await insertQuestion({ type: 'multiple_correct', answer: '3' }), 'type is upper-cased by the trigger');
  assert.ok(await insertQuestion({ type: 'INTEGER', options: [], answer: '-12' }));
  assert.ok(await insertQuestion({ type: 'MATRIX_MATCH', answer: '1', details: { matchLists: LISTS } }));
  assert.ok(await insertQuestion({ type: 'ASSERTION_REASON', answer: '0' }));

  const key = testUuid('a');
  const passage = { key, text: '  A block slides down a smooth incline.  ' };
  const first = await insertQuestion({ type: 'MCQ', answer: '1', details: { passage } });
  const second = await insertQuestion({ type: 'NUMERICAL', options: [], answer: '9.8', details: { passage } });
  const su = await h.asSuperuser();
  const stored = await su.value('SELECT details FROM public.question_bank WHERE id = $1', [first]);
  assert.equal(stored.passage.text, 'A block slides down a smooth incline.', 'passage text is trimmed');
  assert.ok(second);
});

test('the bank rejects malformed answers and details for the new types', async () => {
  for (const answer of ['2,0', '0,0', '', '0,,2', '4', 'A,C']) {
    await assert.rejects(insertQuestion({ type: 'MULTIPLE_CORRECT', answer }), /MULTIPLE_CORRECT requires four options and a valid correct answer/, answer);
  }
  await assert.rejects(insertQuestion({ type: 'INTEGER', options: [], answer: '2.5' }), /Integer questions require no options and a whole-number answer/);
  await assert.rejects(insertQuestion({ type: 'INTEGER', answer: '2' }), /Integer questions require no options/);
  await assert.rejects(insertQuestion({ type: 'MATRIX_MATCH', answer: '1' }), /Matrix match questions require List-I and List-II/);
  await assert.rejects(insertQuestion({ type: 'MATRIX_MATCH', answer: '1', details: { matchLists: { left: ['Only one'], right: ['a', 'b'] } } }), /List-I must have 2 to 6 items/);
  await assert.rejects(insertQuestion({ type: 'MATRIX_MATCH', answer: '1', details: { matchLists: { left: ['a', 'b'], right: ['a', '  '] } } }), /Every List-I and List-II item needs 1 to 2000 characters/);
  await assert.rejects(insertQuestion({ type: 'MCQ', answer: '1', details: { matchLists: LISTS } }), /Only matrix match questions can have List-I and List-II/);
  await assert.rejects(insertQuestion({ type: 'MCQ', answer: '1', details: { hint: 'x' } }), /Question details contain unsupported fields/);
  await assert.rejects(insertQuestion({ type: 'MCQ', answer: '1', details: { passage: { key: 'P1', text: 'Text' } } }), /The paragraph must have a valid key/);
  await assert.rejects(insertQuestion({ type: 'MCQ', answer: '1', details: { passage: { key: testUuid('a'), text: ' ' } } }), /The paragraph must have a valid key/);
  await assert.rejects(insertQuestion({ type: 'ESSAY', answer: '1' }), /Question type is invalid/);
  // Existing messages are unchanged.
  await assert.rejects(insertQuestion({ type: 'MCQ', answer: '4' }), /MCQ requires four options and a correct answer from 0 to 3/);
  await assert.rejects(insertQuestion({ type: 'NUMERICAL', options: [], answer: '1e3' }), /Numerical questions require no options and a valid numeric answer/);
});

test('duplicate detection includes match lists and passages', async () => {
  const stem = 'Match List-I with List-II and choose the correct option.';
  await insertQuestion({ type: 'MATRIX_MATCH', text: stem, answer: '0', details: { matchLists: LISTS } });
  await insertQuestion({ type: 'MATRIX_MATCH', text: stem, answer: '0', details: { matchLists: { left: ['Energy', 'Charge'], right: ['Joule', 'Coulomb'] } } });
  await assert.rejects(
    insertQuestion({ type: 'MATRIX_MATCH', text: stem, answer: '2', details: { matchLists: LISTS } }),
    /question_bank_identity_unique/
  );

  const followUp = 'What is the acceleration of the block?';
  await insertQuestion({ type: 'NUMERICAL', text: followUp, options: [], answer: '1', details: { passage: { key: testUuid('a'), text: 'Passage one' } } });
  await insertQuestion({ type: 'NUMERICAL', text: followUp, options: [], answer: '2', details: { passage: { key: testUuid('a'), text: 'Passage two' } } });

  await insertQuestion({ type: 'MCQ', text: 'Plain duplicate check', answer: '0' });
  await assert.rejects(insertQuestion({ type: 'MCQ', text: '  plain   DUPLICATE check ', answer: '1' }), /question_bank_identity_unique/);
});

test('bank RPCs filter by the real type and return details', async () => {
  const multi = await bankPage('MULTIPLE_CORRECT');
  assert.ok(multi.rows.length >= 2);
  assert.ok(multi.rows.every((row) => row.type === 'MULTIPLE_CORRECT'));

  const matrix = await bankPage('MATRIX_MATCH');
  assert.ok(matrix.rows.length >= 1);
  assert.deepEqual(matrix.rows[0].details.matchLists.left.length >= 2, true);

  const mcq = await bankPage('MCQ');
  assert.ok(mcq.rows.every((row) => row.type === 'MCQ'), 'MCQ filter no longer includes other option types');

  const nat = await bankPage('NAT');
  assert.ok(nat.rows.length >= 1);
  assert.ok(nat.rows.every((row) => ['NUMERICAL', 'NAT'].includes(row.type)));

  const admin = await h.asAdmin();
  await assert.rejects(admin.value(`SELECT public.get_admin_question_bank_page(0, 10, NULL, NULL, 'ESSAY')`), /Question type filter is invalid/);

  const ids = [matrix.rows[0].id];
  const selected = await admin.value('SELECT public.get_admin_questions_by_ids($1::uuid[])', [ids]);
  assert.deepEqual(selected.rows[0].details, matrix.rows[0].details);
});

test('admin_update_passage rewrites the text of every question in the set', async () => {
  const key = testUuid('a');
  const passage = { key, text: 'Original passage' };
  const a = await insertQuestion({ type: 'MCQ', answer: '0', details: { passage } });
  const b = await insertQuestion({ type: 'INTEGER', options: [], answer: '3', details: { passage } });
  const admin = await h.asAdmin();
  assert.equal(await admin.value('SELECT public.admin_update_passage($1, $2)', [key, '  Revised passage  ']), 2);
  const su = await h.asSuperuser();
  const texts = await su.rows('SELECT details #>> \'{passage,text}\' AS text FROM public.question_bank WHERE id = ANY($1::uuid[]) ORDER BY id', [[a, b]]);
  assert.deepEqual(texts.map((row) => row.text), ['Revised passage', 'Revised passage']);

  await assert.rejects(admin.value('SELECT public.admin_update_passage($1, $2)', [key, '   ']), /Paragraph text must contain between 1 and 10000 characters/);
  const student = await h.createStudent({ studentId: 'QT-PASSAGE' });
  const s = await h.asStudent(student.id, student.sessionId);
  await assert.rejects(s.value('SELECT public.admin_update_passage($1, $2)', [key, 'Hijack']), /permission denied|Administrator access/);
  const anon = await h.asAnon();
  await assert.rejects(anon.value('SELECT public.admin_update_passage($1, $2)', [key, 'Hijack']), /permission denied/);
});

test('admin_import_questions accepts the new types and details', async () => {
  const admin = await h.asAdmin();
  const key = testUuid('a');
  const rows = [
    { subject: 'Chemistry', type: 'MULTIPLE_CORRECT', question_text: uniqueText('Imported multi'), options: OPTIONS, correct_answer: '1,3', has_image_or_diagram: false, category: 'Advanced', points: 4, neg_points: -1 },
    { subject: 'Chemistry', type: 'INTEGER', question_text: uniqueText('Imported integer'), options: [], correct_answer: '7', has_image_or_diagram: false, category: 'Advanced', points: 4, neg_points: -1, details: { passage: { key, text: 'Imported passage' } } },
    { subject: 'Chemistry', type: 'MATRIX_MATCH', question_text: uniqueText('Imported matrix'), options: OPTIONS, correct_answer: '2', has_image_or_diagram: false, category: 'Advanced', points: 4, neg_points: -1, details: { matchLists: LISTS } }
  ];
  const result = await admin.value('SELECT public.admin_import_questions($1, $2, $3::jsonb)', [testUuid('b'), 'types.json', JSON.stringify(rows)]);
  assert.equal(result.imported, 3);

  const bad = [{ ...rows[0], question_text: uniqueText('Bad multi'), correct_answer: '3,1' }];
  await assert.rejects(admin.value('SELECT public.admin_import_questions($1, $2, $3::jsonb)', [testUuid('b'), 'bad.json', JSON.stringify(bad)]), /MULTIPLE_CORRECT requires four options and a valid correct answer/);
  const badDetails = [{ ...rows[0], question_text: uniqueText('Bad details'), details: 'text' }];
  await assert.rejects(admin.value('SELECT public.admin_import_questions($1, $2, $3::jsonb)', [testUuid('b'), 'bad.json', JSON.stringify(badDetails)]), /Question details must be an object/);
  const duplicate = [{ ...rows[2], correct_answer: '1' }];
  await assert.rejects(admin.value('SELECT public.admin_import_questions($1, $2, $3::jsonb)', [testUuid('b'), 'dup.json', JSON.stringify(duplicate)]), /A matching question already exists/);
});
