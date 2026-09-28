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

// ---------------------------------------------------------------------------
// Exam papers, marking, patterns and the passage-safe shuffle
// ---------------------------------------------------------------------------

const AR_OPTIONS = [
  'Both (A) and (R) are true and (R) is the correct explanation of (A).',
  'Both (A) and (R) are true but (R) is not the correct explanation of (A).',
  '(A) is true but (R) is false.',
  '(A) is false but (R) is true.'
];
const PAPER_PASSAGE = { key: '00000000-0000-4000-8000-00000000cafe', text: 'A ball is thrown vertically upwards.' };

/** One question of every type plus a two-question paragraph set. */
function typesPaper() {
  return {
    Physics: [
      { id: 'mcq-1', type: 'MCQ', text: 'Single correct', options: OPTIONS, correctAnswer: '1' },
      { id: 'multi-1', type: 'MULTIPLE_CORRECT', text: 'Multiple correct', options: OPTIONS, correctAnswer: '0,1,2' },
      { id: 'int-1', type: 'INTEGER', text: 'Integer type', options: [], correctAnswer: '-12' },
      { id: 'mat-1', type: 'MATRIX_MATCH', text: 'Match the lists', options: OPTIONS, correctAnswer: '2', details: { matchLists: LISTS } },
      { id: 'ar-1', type: 'ASSERTION_REASON', text: 'Assertion (A): x\n\nReason (R): y', options: AR_OPTIONS, correctAnswer: '0' },
      { id: 'para-1', type: 'MCQ', text: 'Paragraph first', options: OPTIONS, correctAnswer: '3', details: { passage: PAPER_PASSAGE } },
      { id: 'para-2', type: 'NUMERICAL', text: 'Paragraph second', options: [], correctAnswer: '2.5', details: { passage: PAPER_PASSAGE } }
    ]
  };
}

const JEE_ADVANCED_MARKING = {
  MCQ: { correct: 3, incorrect: -1 },
  MULTIPLE_CORRECT: { correct: 4, incorrect: -2, partial: true },
  INTEGER: { correct: 4, incorrect: 0 },
  MATRIX_MATCH: { correct: 3, incorrect: -1 }
};

async function createPaperExam({ paper = typesPaper(), marking, status = 'ACTIVE', marksCorrect = 4, marksIncorrect = -1 } = {}) {
  const admin = await h.asAdmin();
  const questionsData = { duration: 60, marksCorrect, marksIncorrect, subjects: Object.keys(paper), questions: paper };
  if (marking !== undefined && marking !== null) questionsData.marking = marking;
  return admin.value(
    `INSERT INTO public.cbt_exams (title, status, class, section, questions_data)
     VALUES ($1, $2, '12', 'A', $3::jsonb) RETURNING id`,
    [`Types exam ${++textCounter}`, status, JSON.stringify(questionsData)]
  );
}

test('exam papers accept every new type and a paragraph set, and activate', async () => {
  const examId = await createPaperExam({ marking: JEE_ADVANCED_MARKING });
  const su = await h.asSuperuser();
  const answers = await su.value('SELECT answers FROM public.cbt_exam_answers WHERE exam_id = $1', [examId]);
  assert.equal(answers['multi-1'].correct_answer, '0,1,2');
  assert.equal(answers['multi-1'].type, 'MULTIPLE_CORRECT');
  const stored = await su.value('SELECT questions_data FROM public.cbt_exams_raw WHERE id = $1', [examId]);
  assert.deepEqual(stored.marking, JEE_ADVANCED_MARKING);
  assert.deepEqual(stored.questions.Physics[3].details, { matchLists: LISTS });
  assert.doesNotMatch(JSON.stringify(stored), /correctAnswer/);
});

test('exam papers reject malformed new-type questions and marking', async () => {
  const withQuestion = (question) => ({ Physics: [question] });
  await assert.rejects(
    createPaperExam({ paper: withQuestion({ id: 'm1', type: 'MATRIX_MATCH', text: 'No lists', options: OPTIONS, correctAnswer: '1' }) }),
    /Matrix match questions require List-I and List-II/
  );
  await assert.rejects(
    createPaperExam({ paper: withQuestion({ id: 'm2', type: 'MULTIPLE_CORRECT', text: 'Unsorted', options: OPTIONS, correctAnswer: '2,0' }) }),
    /MULTIPLE_CORRECT question "m2" has invalid correct answer/
  );
  await assert.rejects(
    createPaperExam({ paper: withQuestion({ id: 'm3', type: 'MULTIPLE_CORRECT', text: 'Three options', options: ['a', 'b', 'c'], correctAnswer: '0' }) }),
    /must have exactly 4 options/
  );
  await assert.rejects(
    createPaperExam({ paper: withQuestion({ id: 'm4', type: 'INTEGER', text: 'Decimal', options: [], correctAnswer: '1.5' }) }),
    /Integer question "m4" has invalid non-integer answer/
  );
  await assert.rejects(
    createPaperExam({ paper: withQuestion({ id: 'm5', type: 'ESSAY', text: 'Essay', options: [], correctAnswer: '1' }) }),
    /unsupported type "ESSAY"/
  );
  for (const [marking, pattern] of [
    [{ MULTIPLE_CORRECT: { correct: 0 } }, /Marks for a correct MULTIPLE_CORRECT answer/],
    [{ MCQ: { correct: 3.555 } }, /Marks for a correct MCQ answer/],
    [{ MCQ: { correct: '3' } }, /Marks for a correct MCQ answer/],
    [{ MCQ: { incorrect: 1 } }, /Marks for a wrong MCQ answer/],
    [{ MCQ: { partial: true } }, /Partial marks can only be set for multiple-correct questions/],
    [{ MULTIPLE_CORRECT: { partial: 'yes' } }, /Partial marks must be true or false/],
    [{ ESSAY: { correct: 1 } }, /Marking has an unsupported question type "ESSAY"/],
    [{ NAT: { correct: 1 } }, /Marking has an unsupported question type "NAT"/],
    [{ MCQ: { bonus: 1 } }, /Marking for MCQ is invalid/],
    [[1], /Marking must be an object keyed by question type/]
  ]) {
    await assert.rejects(createPaperExam({ marking }), pattern, JSON.stringify(marking));
  }
});

test('resolve_question_marking falls back to the exam-wide marks', async () => {
  const su = await h.asSuperuser();
  const paper = { marksCorrect: 4, marksIncorrect: -1, marking: { MULTIPLE_CORRECT: { correct: 4, incorrect: -2 }, NUMERICAL: { incorrect: 0 }, MCQ: { correct: 3 } } };
  const resolve = async (type, data = paper) => {
    const value = await su.value('SELECT public.resolve_question_marking($1::jsonb, $2)', [JSON.stringify(data), type]);
    return { correct: Number(value.correct), incorrect: Number(value.incorrect), partial: value.partial };
  };
  assert.deepEqual(await resolve('MCQ'), { correct: 3, incorrect: -1, partial: true });
  assert.deepEqual(await resolve('MULTIPLE_CORRECT'), { correct: 4, incorrect: -2, partial: true });
  assert.deepEqual(await resolve('NAT'), { correct: 4, incorrect: 0, partial: true });
  assert.deepEqual(await resolve('numerical'), { correct: 4, incorrect: 0, partial: true });
  assert.deepEqual(await resolve('INTEGER'), { correct: 4, incorrect: -1, partial: true });
  assert.deepEqual(await resolve('MULTIPLE_CORRECT', { marksCorrect: 2, marksIncorrect: 0, marking: { MULTIPLE_CORRECT: { partial: false } } }), { correct: 2, incorrect: 0, partial: false });
  assert.deepEqual(await resolve('MCQ', {}), { correct: 4, incorrect: -1, partial: true });
});

test('exam patterns store and return per-type marking', async () => {
  const admin = await h.asAdmin();
  const sections = JSON.stringify([{ subject: 'Physics', questionCount: 5 }]);
  const saved = await admin.value(
    'SELECT public.admin_save_exam_template(NULL, $1, $2, $3, $4, $5, $6::jsonb, true, $7::jsonb)',
    ['JEE Advanced Paper 1', 'Per-type marks', 180, 3, -1, sections, JSON.stringify(JEE_ADVANCED_MARKING)]
  );
  const listed = (await admin.value('SELECT public.admin_list_exam_templates()')).find((t) => t.id === saved.id);
  assert.deepEqual(listed.marking, JEE_ADVANCED_MARKING);

  const legacy = await admin.value(
    'SELECT public.admin_save_exam_template(NULL, $1, $2, $3, $4, $5, $6::jsonb, true)',
    ['Legacy eight-argument pattern', '', 60, 4, -1, sections]
  );
  const listedLegacy = (await admin.value('SELECT public.admin_list_exam_templates()')).find((t) => t.id === legacy.id);
  assert.equal(listedLegacy.marking, null);

  await assert.rejects(
    admin.value(
      'SELECT public.admin_save_exam_template(NULL, $1, $2, $3, $4, $5, $6::jsonb, true, $7::jsonb)',
      ['Broken marking', '', 60, 4, -1, sections, JSON.stringify({ MCQ: { partial: true } })]
    ),
    /Partial marks can only be set for multiple-correct questions/
  );
});

test('the start-of-exam shuffle keeps a paragraph set together and in order', async () => {
  const examId = await createPaperExam({ marking: JEE_ADVANCED_MARKING });
  const expectedIds = typesPaper().Physics.map((q) => q.id).sort();
  const firstPositions = new Set();
  for (let i = 0; i < 16; i += 1) {
    const student = await h.createStudent({ studentId: `QT-SHUFFLE-${i}` });
    const s = await h.asStudent(student.id, student.sessionId);
    const started = await s.value('SELECT public.start_exam_session($1, NULL, NULL)', [examId]);
    const ids = started.jumbled_exam_data.questions.Physics.map((q) => q.id);
    assert.deepEqual([...ids].sort(), expectedIds, 'no question is dropped or duplicated');
    const first = ids.indexOf('para-1');
    assert.equal(ids[first + 1], 'para-2', `paragraph questions stay adjacent and ordered: ${ids.join(',')}`);
    firstPositions.add(ids[0]);
    assert.deepEqual(started.jumbled_exam_data.marking, JEE_ADVANCED_MARKING);
  }
  assert.ok(firstPositions.size > 1, 'the order is still shuffled');
});

// ---------------------------------------------------------------------------
// Candidate answers, grading and the answer review
// ---------------------------------------------------------------------------

async function score(type, correct, selected, marking = { correct: 4, incorrect: -2, partial: true }) {
  const su = await h.asSuperuser();
  const result = await su.value(
    'SELECT public.score_question_response($1, $2, $3, $4::jsonb)',
    [type, correct, selected, JSON.stringify(marking)]
  );
  return [result.outcome, Number(result.marks)];
}

test('score_question_response applies the JEE Advanced multiple-correct rule', async () => {
  assert.deepEqual(await score('MULTIPLE_CORRECT', '0,1,2,3', '0,1,2'), ['PARTIAL', 3]);
  assert.deepEqual(await score('MULTIPLE_CORRECT', '0,1,2,3', '0,1,2,3'), ['CORRECT', 4]);
  assert.deepEqual(await score('MULTIPLE_CORRECT', '0,1,2', '0,1'), ['PARTIAL', 2]);
  assert.deepEqual(await score('MULTIPLE_CORRECT', '0,1,2', '0,3'), ['INCORRECT', -2]);
  assert.deepEqual(await score('MULTIPLE_CORRECT', '1,3', '1'), ['PARTIAL', 1]);
  assert.deepEqual(await score('MULTIPLE_CORRECT', '2', '2'), ['CORRECT', 4]);
  assert.deepEqual(await score('MULTIPLE_CORRECT', '2', '1,2'), ['INCORRECT', -2]);
  assert.deepEqual(await score('MULTIPLE_CORRECT', '0,1,2', null), ['UNATTEMPTED', 0]);
  assert.deepEqual(await score('MULTIPLE_CORRECT', '0,1,2', '0,1', { correct: 4, incorrect: -2, partial: false }), ['INCORRECT', -2]);
  assert.deepEqual(await score('MULTIPLE_CORRECT', '0,1,2,3', '0', { correct: 3, incorrect: -1, partial: true }), ['PARTIAL', 0.75]);
  assert.deepEqual(await score('INTEGER', '-12', '-012'), ['CORRECT', 4]);
  assert.deepEqual(await score('INTEGER', '7', '8'), ['INCORRECT', -2]);
  assert.deepEqual(await score('NUMERICAL', '2.5', '2.50'), ['CORRECT', 4]);
  assert.deepEqual(await score('NAT', '2.5', '2.6'), ['INCORRECT', -2]);
  assert.deepEqual(await score('MATRIX_MATCH', '2', '2'), ['CORRECT', 4]);
  assert.deepEqual(await score('ASSERTION_REASON', '0', '1'), ['INCORRECT', -2]);
  assert.deepEqual(await score('MCQ', '1', '1'), ['CORRECT', 4]);
});

async function startTypesExam(studentId, marking = JEE_ADVANCED_MARKING) {
  const examId = await createPaperExam({ marking });
  const student = await h.createStudent({ studentId });
  const s = await h.asStudent(student.id, student.sessionId);
  const started = await s.value('SELECT public.start_exam_session($1, NULL, NULL)', [examId]);
  return { examId, student, s, started };
}

function progressFor(jumbled, answersById) {
  const progress = {};
  for (const [subject, questions] of Object.entries(jumbled.questions)) {
    progress[subject] = questions.map((question) => (
      Object.hasOwn(answersById, question.id)
        ? { selectedOption: answersById[question.id], status: 'ANSWERED' }
        : { selectedOption: null, status: 'NOT_VISITED' }
    ));
  }
  return progress;
}

test('autosave and submit reject malformed answers for the new types', async () => {
  const { examId, s, started } = await startTypesExam('QT-REJECT');
  const autosave = (answers) => s.value(
    'SELECT public.sync_active_session_progress($1, $2::jsonb, $3)',
    [examId, JSON.stringify(progressFor(started.jumbled_exam_data, answers)), started.version]
  );
  for (const bad of ['2,0', '0,0', '0,,2', '4', '0,1,2,3,4', 'A']) {
    await assert.rejects(autosave({ 'multi-1': bad }), /Invalid multiple-correct response/, bad);
  }
  await assert.rejects(autosave({ 'multi-1': ['0', '2'] }), /Invalid selected option type/);
  await assert.rejects(autosave({ 'int-1': '2.5' }), /Invalid integer response/);
  await assert.rejects(autosave({ 'mat-1': '4' }), /MCQ option is out of range/);
  await assert.rejects(autosave({ 'para-2': 'abc' }), /Invalid numerical response/);

  const saved = await autosave({ 'multi-1': '0,2', 'int-1': '-7' });
  assert.equal(saved.success, true);

  await assert.rejects(
    s.value('SELECT public.submit_exam($1, $2::jsonb, NULL)', [examId, JSON.stringify([{ question_id: 'multi-1', selected_option: '2,0', status: 'ANSWERED' }])]),
    /Invalid multiple-correct response/
  );
});

test('grading uses per-type marks, partial credit and stores the graded review', async () => {
  const { examId, student, s, started } = await startTypesExam('QT-GRADE');
  const answers = {
    'mcq-1': '1',       // correct  +3
    'multi-1': '0,1',   // partial  +2 (two of three correct options)
    'int-1': '-012',    // correct  +4
    'mat-1': '0',       // wrong    -1
    'para-1': '3',      // correct  +3
    'para-2': '2.4'     // wrong    -1 (NUMERICAL falls back to the exam-wide -1)
  };                    // ar-1 unattempted
  const saved = await s.value(
    'SELECT public.sync_active_session_progress($1, $2::jsonb, $3)',
    [examId, JSON.stringify(progressFor(started.jumbled_exam_data, answers)), started.version]
  );
  const result = await s.value('SELECT public.submit_exam($1, $2::jsonb, $3)', [examId, '[]', saved.version]);
  const expected = {
    totalScore: 10,
    maxScore: 25,
    correct: 3,
    partial: 1,
    incorrect: 2,
    unattempted: 1,
    subjectScores: { Physics: 10 }
  };
  const normalize = (r) => ({ ...r, totalScore: Number(r.totalScore), maxScore: Number(r.maxScore), subjectScores: { Physics: Number(r.subjectScores.Physics) } });
  assert.deepEqual(normalize(result), expected);
  assert.deepEqual(normalize(await s.value('SELECT public.get_student_exam_result($1)', [examId])), expected);

  const su = await h.asSuperuser();
  const resultId = await su.value('SELECT id FROM public.student_results WHERE exam_id = $1 AND student_id = $2', [examId, student.studentId]);
  const admin = await h.asAdmin();
  const review = await admin.value('SELECT public.get_admin_student_result_review($1)', [resultId]);
  assert.equal(review.snapshot_format, 'by_question_id');
  assert.equal(review.responses['multi-1'].selected_option, '0,1');
  assert.equal(review.responses['ar-1'].status, 'NOT_VISITED');
  const outcomes = Object.fromEntries(Object.entries(review.question_scores).map(([id, v]) => [id, [v.outcome, Number(v.marks)]]));
  assert.deepEqual(outcomes, {
    'mcq-1': ['CORRECT', 3],
    'multi-1': ['PARTIAL', 2],
    'int-1': ['CORRECT', 4],
    'mat-1': ['INCORRECT', -1],
    'ar-1': ['UNATTEMPTED', 0],
    'para-1': ['CORRECT', 3],
    'para-2': ['INCORRECT', -1]
  });
});

test('an exam without per-type marking grades exactly as before', async () => {
  const { examId, s, started } = await startTypesExam('QT-LEGACY', null);
  const saved = await s.value(
    'SELECT public.sync_active_session_progress($1, $2::jsonb, $3)',
    [examId, JSON.stringify(progressFor(started.jumbled_exam_data, { 'mcq-1': '1', 'multi-1': '0,1,2', 'int-1': '5' })), started.version]
  );
  const result = await s.value('SELECT public.submit_exam($1, $2::jsonb, $3)', [examId, '[]', saved.version]);
  assert.equal(Number(result.maxScore), 28, 'seven questions at the exam-wide +4');
  assert.equal(Number(result.totalScore), 4 + 4 - 1);
  assert.equal(result.partial, 0);
});
