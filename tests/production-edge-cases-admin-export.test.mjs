import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildLeaderboardCsv,
  safeDownloadName,
  validatePdfExport,
  MAX_PDF_RESULT_ROWS
} from '../src/resultExportLogic.js';
import {
  validateImportQuestions,
  canonicalQuestionText,
  MAX_IMPORT_FILE_BYTES,
  MAX_IMPORT_QUESTIONS
} from '../src/importLogic.js';

test('CSV export: immunizes against spreadsheet formula injection (CSV Injection)', () => {
  const maliciousResults = [
    {
      studentId: '=cmd|\'/C calc\'!A0',
      studentName: '+1+1 Formula Student',
      totalScore: 100,
      maxScore: 300,
      subjectScores: { Physics: 100 }
    },
    {
      studentId: '  @SUM(A1:A10)',
      studentName: '-2+3 Negative Student',
      totalScore: -5,
      maxScore: 300,
      subjectScores: { Physics: -5 }
    },
    {
      studentId: 'STU-QUOTES',
      studentName: 'Alice "Ace" O\'Connor',
      totalScore: 80,
      maxScore: 300,
      subjectScores: { Physics: 80 }
    },
    {
      studentId: 'STU-NEWLINE',
      studentName: 'Bob\nMultiline\r\nStudent',
      totalScore: 75,
      maxScore: 300,
      subjectScores: { Physics: 75 }
    }
  ];

  const csv = buildLeaderboardCsv(maliciousResults, ['Physics']);

  // 1. Starts with UTF-8 BOM
  assert.equal(csv.startsWith('\uFEFF'), true);

  // 2. Formula triggers are neutralized with leading single quote
  assert.match(csv, /"'=cmd\|'/);
  assert.match(csv, /"'\+1\+1 Formula Student"/);
  assert.match(csv, /"'@SUM\(A1:A10\)"/);
  assert.match(csv, /"'-2\+3 Negative Student"/);

  // 3. Embedded quotes are doubled
  assert.match(csv, /"Alice ""Ace"" O'Connor"/);

  // 4. Embedded newlines are flattened
  assert.doesNotMatch(csv, /Bob\nMultiline/);
  assert.match(csv, /"Bob Multiline Student"/);

  // 5. Negative scores remain plain numbers in numeric cells, not formula escaped
  assert.match(csv, /,-5,/);
});

test('safeDownloadName: neutralizes Windows reserved device names and illegal characters', () => {
  // Reserved DOS device names
  const reservedNames = ['CON', 'con', 'PRN', 'prn', 'AUX', 'NUL', 'COM1', 'com9', 'LPT1', 'lpt5'];
  for (const name of reservedNames) {
    const safe = safeDownloadName(name);
    assert.equal(safe.startsWith('_'), true, `Expected reserved name ${name} to be prefixed with '_' but got ${safe}`);
  }

  // Illegal filesystem characters: < > : " / \ | ? *
  const dirty = 'JEE: Mains / Advanced * 2026? <Final>';
  const cleaned = safeDownloadName(dirty);
  assert.equal(/[<>:"/\\|?*]/.test(cleaned), false);
  assert.equal(cleaned, 'JEE_ Mains _ Advanced _ 2026_ _Final_');

  // Trailing dots and spaces stripped
  assert.equal(safeDownloadName('Exam Report...  '), 'Exam Report');

  // Length clamped to 100 characters
  const longName = 'A'.repeat(150);
  assert.equal(safeDownloadName(longName).length, 100);
});

test('PDF export validation: enforces row thresholds and flags unrenderable fonts', () => {
  const subjects = ['Physics'];

  // Empty results
  assert.equal(validatePdfExport([], subjects, 'Exam').ok, false);

  // Cohort exceeds 2,000 rows
  const oversized = Array.from({ length: MAX_PDF_RESULT_ROWS + 1 }, (_, i) => ({
    studentId: `STU-${i}`,
    studentName: `Student ${i}`,
    totalScore: 50,
    maxScore: 100,
    subjectScores: { Physics: 50 }
  }));
  const overCheck = validatePdfExport(oversized, subjects, 'Oversized Exam');
  assert.equal(overCheck.ok, false);
  assert.match(overCheck.error, /PDF export is limited to 2000 results/);

  // Unicode non-ASCII characters (e.g. Hindi/Devanagari, Chinese, symbols)
  const unicodeResults = [
    {
      studentId: 'STU-001',
      studentName: 'रोहित शर्मा', // Devanagari
      totalScore: 90,
      maxScore: 100,
      subjectScores: { Physics: 90 }
    }
  ];
  const unicodeCheck = validatePdfExport(unicodeResults, subjects, 'Unicode Exam');
  assert.equal(unicodeCheck.ok, false);
  assert.match(unicodeCheck.error, /PDF export cannot safely render one or more Unicode names/);

  // Standard ASCII valid results pass
  const validResults = [
    {
      studentId: 'STU-001',
      studentName: 'John Doe',
      totalScore: 90,
      maxScore: 100,
      subjectScores: { Physics: 90 }
    }
  ];
  const validCheck = validatePdfExport(validResults, subjects, 'Standard Exam');
  assert.equal(validCheck.ok, true);
});

test('question importer: normalizes types, enforces subject allowlist, and catches duplicates', () => {
  const rawQuestions = [
    {
      // Valid MCQ with letter answer 'B' (should normalize to index '1')
      type: 'MCQ',
      subject: 'Physics',
      text: 'What is the SI unit of force?',
      options: ['Joule', 'Newton', 'Pascal', 'Watt'],
      correctAnswer: 'B'
    },
    {
      // NAT alias for NUMERICAL
      type: 'NAT',
      subject: 'Chemistry',
      text: 'What is the pH of pure water at 25C?',
      options: [],
      correctAnswer: '7.0'
    },
    {
      // Duplicate of question 1 with extra spaces
      type: 'MCQ',
      subject: 'Physics',
      text: '   what  is   the SI unit of   force?   ',
      options: ['Joule', 'Newton', 'Pascal', 'Watt'],
      correctAnswer: '1'
    },
    {
      // Invalid subject (Biology)
      type: 'MCQ',
      subject: 'Biology',
      text: 'Cell question',
      options: ['A', 'B', 'C', 'D'],
      correctAnswer: '0'
    }
  ];

  const validatedQuestions = validateImportQuestions(rawQuestions);
  assert.ok(Array.isArray(validatedQuestions));
  assert.equal(validatedQuestions.length, 4);

  // First question: answer B converted to index 1
  const q1 = validatedQuestions[0];
  assert.equal(q1.correctAnswer, '1');
  assert.equal(q1.type, 'MCQ');

  // Second question: NAT normalized to NUMERICAL
  const q2 = validatedQuestions[1];
  assert.equal(q2.type, 'NUMERICAL');
  assert.equal(q2.correctAnswer, '7.0');

  // Third question: flagged as duplicate in file
  const q3 = validatedQuestions[2];
  assert.ok(q3.rowErrors.some(e => e.code === 'ROW_DUPLICATE_IN_FILE'));

  // Fourth question: flagged for invalid subject
  const q4 = validatedQuestions[3];
  assert.ok(q4.rowErrors.some(e => e.code === 'ROW_INVALID_SUBJECT'));
});
