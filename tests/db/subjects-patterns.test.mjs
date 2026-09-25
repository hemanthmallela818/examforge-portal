import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb } from './harness.mjs';

let h;
let student;

before(async () => {
  h = await createTestDb();
  await h.seedAdministrators();
  await h.createClass('12', ['A']);
  student = await h.createStudent({ studentId: 'SUBJ-S1' });
});

after(async () => {
  await h?.close();
});

async function subjectByName(name) {
  const su = await h.asSuperuser();
  return (await su.rows('SELECT id, name, is_active FROM public.subjects WHERE lower(name) = lower($1)', [name]))[0];
}

async function saveSubject(id, name, isActive = true) {
  const admin = await h.asAdmin();
  return admin.value('SELECT public.admin_save_subject($1, $2, $3)', [id, name, isActive]);
}

async function saveTemplate({ id = null, name, description = '', duration = 60, marksCorrect = 4, marksIncorrect = -1, sections, isActive = true }) {
  const admin = await h.asAdmin();
  return admin.value(
    'SELECT public.admin_save_exam_template($1, $2, $3, $4, $5, $6, $7, $8)',
    [id, name, description, duration, marksCorrect, marksIncorrect, sections, isActive]
  );
}

async function insertQuestion(subject, text = `Question about ${subject} ${Math.random()}`) {
  const admin = await h.asAdmin();
  return admin.value(
    `INSERT INTO public.question_bank (subject, type, question_text, options, correct_answer)
     VALUES ($1, 'NUMERICAL', $2, '[]', '1') RETURNING subject`,
    [subject, text]
  );
}

test('the migration seeds the default subjects and JEE Main pattern', async () => {
  const admin = await h.asAdmin();
  const subjects = await admin.value('SELECT public.admin_list_subjects()');
  assert.deepEqual(subjects.map((s) => [s.name, s.isActive]), [
    ['Physics', true], ['Chemistry', true], ['Mathematics', true]
  ]);
  const templates = await admin.value('SELECT public.admin_list_exam_templates()');
  assert.ok(JSON.stringify(templates).includes('JEE Main'));
});

test('admin_save_subject enforces names and case-insensitive uniqueness', async () => {
  await assert.rejects(saveSubject(null, 'physics'), /A subject named "physics" already exists/);
  await assert.rejects(saveSubject(null, '  PHYSICS  '), /already exists/);
  await assert.rejects(saveSubject(null, '   '), /Enter a subject name/);
  await assert.rejects(saveSubject(null, '#Hash'), /must start with a letter or number/);
  await assert.rejects(saveSubject(null, 'Bad;Name'), /may contain letters, numbers/);
  await assert.rejects(saveSubject(null, 'x'.repeat(61)), /at most 60 characters/);

  const created = await saveSubject(null, '  Computer   Science ');
  assert.equal(created.name, 'Computer Science', 'whitespace is normalized');
  assert.equal(created.isActive, true);

  // Renaming an unused subject is allowed; renaming onto another name is not.
  const renamed = await saveSubject(created.id, 'Informatics');
  assert.equal(renamed.name, 'Informatics');
  await assert.rejects(saveSubject(created.id, 'chemistry'), /already exists/);

  const su = await h.asSuperuser();
  const actions = await su.rows(
    `SELECT action FROM public.admin_audit_events WHERE target_type = 'subject' ORDER BY occurred_at`
  );
  assert.deepEqual(actions.map((a) => a.action), ['CREATE_SUBJECT', 'UPDATE_SUBJECT']);
});

test('subjects in use cannot be renamed or deleted; unused ones can be deleted', async () => {
  const biology = await saveSubject(null, 'Biology');
  assert.equal(await insertQuestion('biology'), 'Biology', 'question subject is canonicalized');

  await assert.rejects(saveSubject(biology.id, 'Life Science'), /cannot be renamed/);
  await assert.rejects(saveSubject(biology.id, 'BIOLOGY'), /cannot be renamed/, 'even case changes are blocked');
  const admin = await h.asAdmin();
  await assert.rejects(admin.query('SELECT public.admin_delete_subject($1)', [biology.id]), /cannot be deleted/);

  // Used only by an exam snapshot also blocks rename/delete.
  const geology = await saveSubject(null, 'Geology');
  await h.createExam({
    status: 'PENDING',
    paper: { Geology: [{ id: 'geo-1', type: 'NUMERICAL', text: 'Layers?', options: [], correctAnswer: '3' }] }
  });
  await assert.rejects(saveSubject(geology.id, 'Earth Science'), /cannot be renamed/);
  await assert.rejects(admin.query('SELECT public.admin_delete_subject($1)', [geology.id]), /cannot be deleted/);

  const unused = await saveSubject(null, 'Astronomy');
  assert.deepEqual(await admin.value('SELECT public.admin_delete_subject($1)', [unused.id]), { deleted: true });
  assert.equal(await subjectByName('Astronomy'), undefined);
});

test('deactivation is blocked while an active pattern uses the subject', async () => {
  const physics = await subjectByName('Physics');
  await assert.rejects(saveSubject(physics.id, 'Physics', false), /used by 1 active pattern/);

  const botany = await saveSubject(null, 'Botany');
  const pattern = await saveTemplate({
    name: 'Botany Drill',
    sections: [{ subject: 'botany', questionCount: 5 }]
  });
  await assert.rejects(saveSubject(botany.id, 'Botany', false), /active pattern/);

  // Deactivate the pattern first, then the subject can be deactivated.
  await saveTemplate({ id: pattern.id, name: 'Botany Drill', sections: [{ subject: 'Botany', questionCount: 5 }], isActive: false });
  const deactivated = await saveSubject(botany.id, 'Botany', false);
  assert.equal(deactivated.isActive, false);

  // Inactive subjects cannot be used in (re)activated patterns.
  await assert.rejects(
    saveTemplate({ id: pattern.id, name: 'Botany Drill', sections: [{ subject: 'Botany', questionCount: 5 }] }),
    /Subject "Botany" is inactive/
  );
});

test('admin_save_exam_template validates every field', async () => {
  const sections = [{ subject: 'Physics', questionCount: 10 }];
  const cases = [
    [{ name: 'jee main', sections }, /A pattern named "jee main" already exists/],
    [{ name: '   ', sections }, /Pattern name must be between 1 and 80 characters/],
    [{ name: 'Long description', description: 'x'.repeat(501), sections }, /at most 500 characters/],
    [{ name: 'Zero duration', duration: 0, sections }, /Duration must be between 1 and 600/],
    [{ name: 'Free marks', marksCorrect: 0, sections }, /greater than 0/],
    [{ name: 'Positive negative', marksIncorrect: 1, sections }, /between -100 and 0/],
    [{ name: 'Precise marks', marksCorrect: 1.125, sections }, /at most two decimal places/],
    [{ name: 'No sections', sections: [] }, /at least one subject section/],
    [{ name: 'Not a list', sections: { subject: 'Physics' } }, /list of subject sections/],
    [{ name: 'Unknown subject', sections: [{ subject: 'Alchemy', questionCount: 1 }] }, /Unknown subject "Alchemy"/],
    [{ name: 'Duplicate subject', sections: [...sections, { subject: 'PHYSICS', questionCount: 2 }] }, /appears more than once/],
    [{ name: 'Zero questions', sections: [{ subject: 'Physics', questionCount: 0 }] }, /between 1 and 500/],
    [{ name: 'Fractional questions', sections: [{ subject: 'Physics', questionCount: 2.5 }] }, /whole number/],
    [{
      name: 'Too many questions',
      sections: [{ subject: 'Physics', questionCount: 300 }, { subject: 'Chemistry', questionCount: 201 }]
    }, /at most 500 questions in total/]
  ];
  for (const [input, expected] of cases) {
    await assert.rejects(saveTemplate(input), expected, `${input.name} should be rejected`);
  }

  const saved = await saveTemplate({
    name: '  Mixed   Mock ',
    sections: [{ subject: 'physics', questionCount: '10' }, { subject: 'Chemistry', questionCount: 5 }]
  });
  assert.equal(saved.name, 'Mixed Mock');
  const su = await h.asSuperuser();
  assert.deepEqual(
    await su.value('SELECT sections FROM public.exam_templates WHERE id = $1', [saved.id]),
    [{ subject: 'Physics', questionCount: 10 }, { subject: 'Chemistry', questionCount: 5 }]
  );
});

test('validate_question_bank_content only accepts active configured subjects for new questions', async () => {
  assert.equal(await insertQuestion('  chemistry '), 'Chemistry');
  await assert.rejects(insertQuestion('Alchemy'), /Question subject "Alchemy" is not an active subject/);

  const zoology = await saveSubject(null, 'Zoology');
  const admin = await h.asAdmin();
  const questionId = await admin.value(
    `INSERT INTO public.question_bank (subject, type, question_text, options, correct_answer)
     VALUES ('Zoology', 'MCQ', 'Largest mammal?', '["Whale","Elephant","Giraffe","Hippo"]', '0') RETURNING id`
  );
  await saveSubject(zoology.id, 'Zoology', false);

  await assert.rejects(insertQuestion('Zoology'), /not an active subject/);
  // Existing questions keep working after their subject is deactivated ...
  await admin.query(`UPDATE public.question_bank SET question_text = 'Largest living mammal?' WHERE id = $1`, [questionId]);
  // ... but cannot be moved to an unknown or inactive subject.
  await assert.rejects(
    admin.query(`UPDATE public.question_bank SET subject = 'Alchemy' WHERE id = $1`, [questionId]),
    /not an active subject/
  );
  const moved = await admin.value(
    `UPDATE public.question_bank SET subject = 'physics' WHERE id = $1 RETURNING subject`,
    [questionId]
  );
  assert.equal(moved, 'Physics');
});

test('preflight_validate_exam rejects unknown subjects and blocks activation', async () => {
  const examId = await h.createExam({
    status: 'PENDING',
    paper: { Alchemy: [{ id: 'alc-1', type: 'NUMERICAL', text: 'Lead to gold?', options: [], correctAnswer: '0' }] }
  });
  const admin = await h.asAdmin();
  const preflight = await admin.value('SELECT public.preflight_validate_exam($1)', [examId]);
  assert.equal(preflight.valid, false);
  assert.ok(
    preflight.errors.some((e) => /Unknown subject "Alchemy"/.test(e)),
    `expected an unknown-subject error, got ${JSON.stringify(preflight.errors)}`
  );
  await assert.rejects(
    admin.query(`UPDATE public.cbt_exams SET status = 'ACTIVE' WHERE id = $1`, [examId]),
    /preflight validation failed/
  );
  await assert.rejects(
    h.createExam({
      status: 'ACTIVE',
      paper: { Alchemy: [{ id: 'alc-2', type: 'NUMERICAL', text: 'Again?', options: [], correctAnswer: '0' }] }
    }),
    /Unknown subject "Alchemy"/
  );

  // Known subjects are matched case-insensitively.
  const okId = await h.createExam({
    status: 'PENDING',
    paper: { physics: [{ id: 'phy-ci', type: 'NUMERICAL', text: 'g?', options: [], correctAnswer: '9.8' }] }
  });
  assert.equal((await admin.value('SELECT public.preflight_validate_exam($1)', [okId])).valid, true);
});

test('students and anonymous callers cannot use subject/pattern administration', async () => {
  const physics = await subjectByName('Physics');
  const callers = [await h.asStudent(student.id, student.sessionId), await h.asAnon()];
  for (const caller of callers) {
    const expected = caller.identity.role === 'anon'
      ? /permission denied/
      : /Administrator access (is|with MFA \(AAL2\) is) required|permission denied/;
    await assert.rejects(caller.query(`SELECT public.admin_save_subject(NULL, 'Hacking', true)`), expected);
    await assert.rejects(caller.query('SELECT public.admin_delete_subject($1)', [physics.id]), expected);
    await assert.rejects(caller.query('SELECT public.admin_list_subjects()'), expected);
    await assert.rejects(caller.query('SELECT public.admin_list_exam_templates()'), expected);
    await assert.rejects(
      caller.query(
        `SELECT public.admin_save_exam_template(NULL, 'Hack', '', 60, 4, -1, '[{"subject":"Physics","questionCount":1}]'::jsonb, true)`
      ),
      expected
    );
    await assert.rejects(caller.query('SELECT * FROM public.subjects'), /permission denied for table subjects/);
    await assert.rejects(caller.query('SELECT * FROM public.exam_templates'), /permission denied for table exam_templates/);
    await assert.rejects(caller.query('SELECT public.preflight_validate_exam(gen_random_uuid())'), expected);
  }
  assert.equal(await subjectByName('Hacking'), undefined);
});
