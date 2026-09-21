import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AUTHOR_NUMERICAL_MAX_LENGTH,
  NUMERICAL_ABSOLUTE_TOLERANCE,
  validateNumericalAnswer,
  isValidNumericalAnswer,
  isPotentialNumericalAnswer
} from '../src/numericalAnswerPolicy.js';
import {
  buildLeaderboard,
  calculateResultAnalytics
} from '../src/resultExportLogic.js';
import { validateExamPreflight } from '../src/examPreflightLogic.js';

test('numerical policy: handles intermediate and signed zero states with precision', () => {
  // Transient intermediate states
  const transientInputs = ['-', '+', '.', '+.', '-.'];
  for (const input of transientInputs) {
    const res = validateNumericalAnswer(input);
    assert.equal(res.valid, false, `Expected ${input} to be invalid`);
    assert.equal(res.transient, true, `Expected ${input} to be transient`);
    assert.equal(isPotentialNumericalAnswer(input), true);
    assert.equal(isValidNumericalAnswer(input), false);
  }

  // Valid leading zeros and signed zeros
  const validInputs = [
    '0', '-0', '+0', '0.0', '-0.0', '+0.0',
    '007', '000.500', '-00.123', '+00.456',
    '.5', '-.5', '+.75', '123.', '-123.'
  ];
  for (const input of validInputs) {
    const res = validateNumericalAnswer(input);
    assert.equal(res.valid, true, `Expected ${input} to be valid`);
    assert.equal(res.transient, false);
    assert.equal(isValidNumericalAnswer(input), true);
  }

  // Invalid scientific notation, fractions, expressions, commas
  const invalidInputs = [
    '1e5', '1E-4', '2.5e+3', '2+2', '1/3', '5*10',
    ' 42', '42 ', '4 2', '\t12', '\n5',
    '1,000', '1,234.56', 'NaN', 'Infinity', '-Infinity',
    'undefined', 'null', 'True', 'False', '--5', '++5', '..5', '1..2'
  ];
  for (const input of invalidInputs) {
    const res = validateNumericalAnswer(input);
    assert.equal(res.valid, false, `Expected ${input} to be invalid`);
    assert.equal(res.transient, false, `Expected ${input} to be non-transient invalid`);
    assert.equal(isValidNumericalAnswer(input), false);
  }
});

test('numerical policy: strictly enforces length boundaries', () => {
  // Candidate max length: 64
  const len64 = '9'.repeat(64);
  const len65 = '9'.repeat(65);
  assert.equal(validateNumericalAnswer(len64).valid, true);
  assert.equal(validateNumericalAnswer(len65).valid, false);
  assert.match(validateNumericalAnswer(len65).error, /Use at most 64 characters/);

  // Author max length: 100
  const len100 = '9'.repeat(100);
  const len101 = '9'.repeat(101);
  assert.equal(validateNumericalAnswer(len100, AUTHOR_NUMERICAL_MAX_LENGTH).valid, true);
  assert.equal(validateNumericalAnswer(len101, AUTHOR_NUMERICAL_MAX_LENGTH).valid, false);
  assert.match(validateNumericalAnswer(len101, AUTHOR_NUMERICAL_MAX_LENGTH).error, /Use at most 100 characters/);
});

test('numerical tolerance: verifies absolute tolerance delta policy', () => {
  assert.equal(NUMERICAL_ABSOLUTE_TOLERANCE, 0.00001);
  const isMatch = (cand, correct) => Math.abs(Number(cand) - Number(correct)) < NUMERICAL_ABSOLUTE_TOLERANCE;

  // Within tolerance
  assert.equal(isMatch('3.141592', '3.141599'), true);
  assert.equal(isMatch('0.000001', '0.000005'), true);
  assert.equal(isMatch('-5.000002', '-5.000008'), true);

  // Outside tolerance
  assert.equal(isMatch('3.14159', '3.14170'), false);
  assert.equal(isMatch('0.0001', '0.0002'), false);
  assert.equal(isMatch('10', '10.00002'), false);
});

test('scoring & leaderboard: handles negative totals, competition tie ranks, and multi-subject ordering', () => {
  const mockResults = [
    {
      studentId: 'STU-001',
      studentName: 'Alice Alpha',
      totalScore: 120,
      maxScore: 300,
      subjectScores: { Physics: 40, Chemistry: 40, Mathematics: 40 }
    },
    {
      studentId: 'STU-002',
      studentName: 'Bob Beta',
      totalScore: 120,
      maxScore: 300,
      subjectScores: { Physics: 50, Chemistry: 30, Mathematics: 40 }
    },
    {
      studentId: 'STU-003',
      studentName: 'Charlie Gamma',
      totalScore: 90,
      maxScore: 300,
      subjectScores: { Physics: 30, Chemistry: 30, Mathematics: 30 }
    },
    {
      studentId: 'STU-004',
      studentName: 'David Delta',
      totalScore: -15, // Negative total score from negative marking
      maxScore: 300,
      subjectScores: { Physics: -5, Chemistry: -5, Mathematics: -5 }
    }
  ];

  const subjects = ['Physics', 'Chemistry', 'Mathematics'];
  const leaderboard = buildLeaderboard(mockResults, subjects);

  // Ranks should be 1, 1 (tie), 3, 4
  assert.equal(leaderboard[0].totalRank, 1);
  assert.equal(leaderboard[1].totalRank, 1);
  assert.equal(leaderboard[2].totalRank, 3);
  assert.equal(leaderboard[3].totalRank, 4);

  // Subject ranks in Physics: Bob has 50 (Rank 1), Alice has 40 (Rank 2), Charlie has 30 (Rank 3), David has -5 (Rank 4)
  const bob = leaderboard.find(r => r.studentId === 'STU-002');
  const alice = leaderboard.find(r => r.studentId === 'STU-001');
  const david = leaderboard.find(r => r.studentId === 'STU-004');
  assert.equal(bob.subjectRanks.Physics, 1);
  assert.equal(alice.subjectRanks.Physics, 2);
  assert.equal(david.subjectRanks.Physics, 4);

  // Analytics with negative scores
  const analytics = calculateResultAnalytics(mockResults, subjects);
  assert.ok(analytics);
  assert.equal(analytics.highestScore, 120);
  assert.equal(analytics.lowestScore, -15);
  assert.equal(analytics.averageScore, (120 + 120 + 90 - 15) / 4); // 315 / 4 = 78.75
  const physicsAvg = analytics.subjectAverages.find(s => s.name === 'Physics');
  assert.equal(physicsAvg.score, 28.75); // (40 + 50 + 30 - 5) / 4 = 115 / 4 = 28.75
  // David's percentage is -5%, which falls into '0-20%' bucket
  const bucket020 = analytics.distribution.find(d => d.name === '0-20%');
  assert.equal(bucket020.count, 1);
});

test('scoring & leaderboard: fails closed on duplicates and malformed rows', () => {
  // Duplicate student IDs
  const duplicates = [
    { studentId: 'STU-DUP', studentName: 'First', totalScore: 10, maxScore: 100 },
    { studentId: 'STU-DUP', studentName: 'Second', totalScore: 20, maxScore: 100 }
  ];
  assert.throws(() => buildLeaderboard(duplicates), /Duplicate result found for student STU-DUP/);

  // Missing student ID
  assert.throws(() => buildLeaderboard([{ studentId: '', studentName: 'No ID', totalScore: 10, maxScore: 100 }]), /has no student ID/);

  // Missing student name
  assert.throws(() => buildLeaderboard([{ studentId: 'STU-1', studentName: '   ', totalScore: 10, maxScore: 100 }]), /has no student name/);

  // Non-finite score
  assert.throws(() => buildLeaderboard([{ studentId: 'STU-1', studentName: 'Name', totalScore: 'Infinity', maxScore: 100 }]), /Total score for STU-1 is missing or invalid/);
});

test('preflight: catches structural, subject, option, and scoring configuration errors', () => {
  const baseValidExam = {
    title: 'Comprehensive JEE Mock',
    class: 'Class 12',
    section: 'A',
    duration: 180,
    marksCorrect: 4,
    marksIncorrect: -1,
    subjects: ['Physics'],
    questions: {
      Physics: [
        {
          id: 'phy-01',
          type: 'MCQ',
          text: 'What is gravitational acceleration on Earth?',
          options: ['9.8 m/s^2', '8.9 m/s^2', '9.0 m/s^2', '10.8 m/s^2'],
          correctAnswer: 0
        }
      ]
    }
  };

  // Valid exam passes preflight
  const validCheck = validateExamPreflight(baseValidExam);
  assert.equal(validCheck.valid, true, `Expected valid exam to pass: ${validCheck.errors.join(', ')}`);

  // Invalid duration <= 0
  const zeroDuration = { ...baseValidExam, duration: 0 };
  assert.equal(validateExamPreflight(zeroDuration).valid, false);

  // Invalid marksIncorrect > 0 (e.g. positive penalty)
  const positivePenalty = { ...baseValidExam, marksIncorrect: 1 };
  assert.equal(validateExamPreflight(positivePenalty).valid, false);

  // Subject mismatch (declared 'Chemistry' in subjects array, but only 'Physics' in questions)
  const subjectMismatch = { ...baseValidExam, subjects: ['Physics', 'Chemistry'] };
  assert.equal(validateExamPreflight(subjectMismatch).valid, false);

  // MCQ with 3 options instead of 4
  const threeOptions = {
    ...baseValidExam,
    questions: {
      Physics: [
        {
          id: 'phy-01',
          type: 'MCQ',
          text: 'What is 2+2?',
          options: ['1', '2', '4'],
          correctAnswer: 2
        }
      ]
    }
  };
  assert.equal(validateExamPreflight(threeOptions).valid, false);

  // MCQ with correctAnswer out of range (index 4 for 4 options)
  const outOfRangeAnswer = {
    ...baseValidExam,
    questions: {
      Physics: [
        {
          id: 'phy-01',
          type: 'MCQ',
          text: 'Question text',
          options: ['A', 'B', 'C', 'D'],
          correctAnswer: 4
        }
      ]
    }
  };
  assert.equal(validateExamPreflight(outOfRangeAnswer).valid, false);

  // Numerical question with invalid format answer
  const invalidNumericalAnswer = {
    ...baseValidExam,
    questions: {
      Physics: [
        {
          id: 'phy-num-01',
          type: 'NUMERICAL',
          text: 'Calculate value',
          options: [],
          correctAnswer: '3.14.15' // Invalid multiple decimals
        }
      ]
    }
  };
  assert.equal(validateExamPreflight(invalidNumericalAnswer).valid, false);
});
