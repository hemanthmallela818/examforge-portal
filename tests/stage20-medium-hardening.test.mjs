import test from 'node:test';
import assert from 'node:assert/strict';
import { validateExamPreflight } from '../src/examPreflightLogic.js';
import { parseResultPageResponse } from '../src/resultPaging.js';
import { validateImportQuestions } from '../src/importLogic.js';
import { redactDiagnosticText } from '../src/runtimeDiagnostics.js';

// Stage 20 — regression coverage for the "medium" correctness/robustness fixes
// (M-1, M-2, M-3, M-4, M-6) applied during production hardening. Each test
// asserts the post-fix behaviour AND, where cheap, the safe/valid path so the
// fix cannot silently over-correct and start rejecting good input.

// ---------------------------------------------------------------------------
// M-1: exam preflight must survive null / non-object question entries instead
// of throwing a TypeError (q.id on a null entry) that aborts the whole check.
// ---------------------------------------------------------------------------
test('M-1: preflight reports malformed question entries without crashing', () => {
  const validMcq = {
    id: 'p1', type: 'MCQ', text: 'What is 2 + 2?',
    options: ['1', '2', '3', '4'], correctAnswer: '3'
  };
  const exam = {
    title: 'Robustness Exam',
    class: 'Class 12',
    section: 'A',
    duration: 180,
    marksCorrect: 4,
    marksIncorrect: -1,
    subjects: ['Physics'],
    questions: { Physics: [null, 'not-an-object', validMcq] }
  };

  let result;
  assert.doesNotThrow(() => { result = validateExamPreflight(exam); },
    'a null/malformed question entry must not throw');
  assert.equal(result.valid, false);
  // Both the null entry and the string entry are flagged as malformed.
  const malformed = result.errors.filter(e => /missing or malformed/i.test(e));
  assert.equal(malformed.length, 2, 'both malformed entries should be reported');
  // The loop still counted every array slot and processed the valid question.
  assert.equal(result.stats.totalQuestions, 3);
  // The one genuinely valid MCQ contributed no per-question errors.
  assert.ok(!result.errors.some(e => /Q3\]/.test(e)),
    'the valid third question should not raise an error');
});

// ---------------------------------------------------------------------------
// M-2: ranked-result parsing uses strict numeric coercion. null / '' / boolean
// scores must fail loudly rather than becoming 0 / 1 (a fabricated score).
// ---------------------------------------------------------------------------
test('M-2: result parsing rejects null/boolean/empty scores instead of coercing', () => {
  const row = (id, studentId, over = {}) => ({
    id, exam_id: 'exam', student_id: studentId, student_name: `Name ${studentId}`,
    total_score: '4', max_score: '8',
    subject_scores: { Physics: 4 }, subject_ranks: { Physics: 1 }, total_rank: 1,
    ...over
  });
  const analytics = () => ({
    average_score: 4, highest_score: 4, lowest_score: 4,
    excluded_from_distribution: 0,
    distribution: [
      { name: '0-20%', count: 0 }, { name: '21-40%', count: 0 },
      { name: '41-60%', count: 2 }, { name: '61-80%', count: 0 },
      { name: '81-100%', count: 0 }
    ],
    subject_averages: [{ name: 'Physics', score: 4 }]
  });
  const envelope = (rows, over = {}) => ({
    page: 0, page_size: 2, total: 2, result_count: 2, subjects: ['Physics'],
    analytics: analytics(), rows, ...over
  });
  const opts = { expectedPage: 0, expectedPageSize: 2 };

  // Valid path still works with strict coercion (numeric strings accepted).
  const ok = parseResultPageResponse(envelope([row('a', 'S1'), row('b', 'S2')]), opts);
  assert.equal(ok.rows[0].totalScore, 4);
  assert.equal(ok.rows[1].maxScore, 8);

  // null total_score previously slipped through as Number(null) === 0.
  assert.throws(
    () => parseResultPageResponse(envelope([row('a', 'S1', { total_score: null }), row('b', 'S2')]), opts),
    /Total score/);

  // boolean max_score previously became Number(true) === 1.
  assert.throws(
    () => parseResultPageResponse(envelope([row('a', 'S1'), row('b', 'S2', { max_score: true })]), opts),
    /Maximum score/);

  // Empty-string analytics average previously became 0.
  assert.throws(
    () => parseResultPageResponse(
      envelope([row('a', 'S1'), row('b', 'S2')], { analytics: { ...analytics(), average_score: '' } }),
      opts),
    /Average score/);
});

// ---------------------------------------------------------------------------
// M-3: the importer treats NAT (Numerical Answer Type) as a canonical alias of
// NUMERICAL so valid numeric questions are not rejected as an unknown type.
// ---------------------------------------------------------------------------
test('M-3: importer normalizes NAT to NUMERICAL and validates the numeric answer', () => {
  const [nat] = validateImportQuestions([{
    question_number: 1, question_text: 'What is 2 + 2?', question_type: 'NAT',
    options: [], correct_answer: '4', subject: 'Mathematics', has_image_or_diagram: false
  }]);
  assert.equal(nat.type, 'NUMERICAL');
  assert.equal(nat.approved, true);
  assert.deepEqual(nat.rowErrors, []);

  // Lowercase 'nat' must normalize too (types are upper-cased before mapping).
  const [natLower] = validateImportQuestions([{
    question_text: '5 * 5 = ?', question_type: 'nat',
    options: [], correct_answer: '25', subject: 'Physics', has_image_or_diagram: false
  }]);
  assert.equal(natLower.type, 'NUMERICAL');
  assert.equal(natLower.approved, true);

  // A NAT question with a non-numeric answer is still rejected — mapping the
  // type must not weaken the numeric-answer validation.
  const [badNat] = validateImportQuestions([{
    question_text: 'bad answer', question_type: 'NAT',
    options: [], correct_answer: 'not-a-number', subject: 'Physics', has_image_or_diagram: false
  }]);
  assert.equal(badNat.type, 'NUMERICAL');
  assert.equal(badNat.approved, false);
  assert.ok(badNat.rowErrors.some(e => e.code === 'ROW_INVALID_NUMERICAL_ANSWER'));

  // A genuinely unknown type is still rejected as such.
  const [unknown] = validateImportQuestions([{
    question_text: 'mystery', question_type: 'ESSAY',
    options: [], correct_answer: 'x', subject: 'Physics', has_image_or_diagram: false
  }]);
  assert.ok(unknown.rowErrors.some(e => e.code === 'ROW_INVALID_TYPE'));
});

// ---------------------------------------------------------------------------
// M-4: diagnostic redaction must (a) strip opaque (non-JWT) Bearer tokens and
// (b) bound the work it does on hostile/oversized input.
// ---------------------------------------------------------------------------
test('M-4: opaque Bearer tokens are fully redacted', () => {
  const opaque = 'k'.repeat(48); // no dots -> not caught by the JWT rule
  const redacted = redactDiagnosticText(`Authorization: Bearer ${opaque}`);
  assert.doesNotMatch(redacted, new RegExp(opaque), 'the opaque token must not survive');
  assert.match(redacted, /\[REDACTED\]/);
});

test('M-4: dotted JWT-shaped tokens are still redacted', () => {
  const jwt = `${'a'.repeat(24)}.${'b'.repeat(24)}.${'c'.repeat(16)}`;
  const redacted = redactDiagnosticText(`token ${jwt}`);
  assert.doesNotMatch(redacted, /aaaaaaaa/);
  assert.match(redacted, /\[REDACTED_TOKEN\]/);
});

test('M-4: redaction bounds work on oversized input (no unbounded scan)', () => {
  const huge = 'a'.repeat(500_000);
  const start = Date.now();
  const redacted = redactDiagnosticText(huge);
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 2000, `redaction should be near-instant, took ${elapsed}ms`);
  assert.ok(redacted.length <= 1000, 'output is capped at 1000 characters');
});

// ---------------------------------------------------------------------------
// M-6: dialog helpers must resolve a safe default when no host is mounted,
// and still resolve the real answer when a host acknowledges (preventDefault).
// Runs against a minimal EventTarget/CustomEvent shim in the Node test env.
// ---------------------------------------------------------------------------
test('M-6: dialog helpers never hang when no host is mounted, resolve when one is', async () => {
  const savedWindow = globalThis.window;
  const savedCustomEvent = globalThis.CustomEvent;
  if (typeof globalThis.CustomEvent === 'undefined') {
    globalThis.CustomEvent = class extends Event {
      constructor(type, opts = {}) { super(type, opts); this.detail = opts.detail; }
    };
  }
  globalThis.window = new EventTarget();

  try {
    // Import after globals exist. requestDialog reads window at call-time, so a
    // cache-busting query keeps this independent of any earlier import.
    const { customAlert, customConfirm, customPrompt } =
      await import('../src/utils.js?stage20-no-host');

    // No listener -> resolve safe, non-destructive defaults (never hang).
    assert.equal(await customConfirm('proceed?'), false);
    assert.equal(await customPrompt('name?', 'seed'), null);
    assert.equal(await customAlert('notice'), undefined);

    // A mounted host acknowledges via preventDefault and resolves later.
    const host = (e) => {
      e.preventDefault();
      setTimeout(() => e.detail.onResolve('answered'), 0);
    };
    globalThis.window.addEventListener('show-dialog', host);
    assert.equal(await customPrompt('name?'), 'answered');
    globalThis.window.removeEventListener('show-dialog', host);
  } finally {
    globalThis.window = savedWindow;
    globalThis.CustomEvent = savedCustomEvent;
  }
});
