import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { isAllowedExamShortcut } from '../src/features/exam/useExamLockdown.js';
import { readExamSource } from './support/examSource.mjs';

const source = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const key = (value, modifiers = {}) => ({ key: value, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, ...modifiers });

test('lockdown allows only the exam shortcuts and bare modifier presses', () => {
  for (const letter of ['s', 'm', 'c', 'n', 'p', 'S', 'M', 'C', 'N', 'P']) {
    assert.equal(isAllowedExamShortcut(key(letter, { altKey: true })), true, `Alt+${letter}`);
  }
  assert.equal(isAllowedExamShortcut(key('Enter', { ctrlKey: true })), true, 'Ctrl+Enter');
  for (const modifier of ['Alt', 'AltGraph', 'Control', 'Meta', 'Shift', 'OS']) {
    assert.equal(isAllowedExamShortcut(key(modifier)), true, modifier);
  }

  assert.equal(isAllowedExamShortcut(key('c', { ctrlKey: true })), false, 'Ctrl+C');
  assert.equal(isAllowedExamShortcut(key('v', { metaKey: true })), false, 'Meta+V');
  assert.equal(isAllowedExamShortcut(key('Tab', { altKey: true })), false, 'Alt+Tab');
  assert.equal(isAllowedExamShortcut(key('x', { altKey: true })), false, 'Alt+X');
  assert.equal(isAllowedExamShortcut(key('s', { altKey: true, ctrlKey: true })), false, 'Ctrl+Alt+S');
  assert.equal(isAllowedExamShortcut(key('s', { altKey: true, metaKey: true })), false, 'Meta+Alt+S');
  assert.equal(isAllowedExamShortcut(key('Enter', { ctrlKey: true, shiftKey: true })), false, 'Ctrl+Shift+Enter');
  assert.equal(isAllowedExamShortcut(key('Enter', { ctrlKey: true, altKey: true })), false, 'Ctrl+Alt+Enter');
  assert.equal(isAllowedExamShortcut(key('Escape')), false, 'Escape');
  assert.equal(isAllowedExamShortcut(key('F12')), false, 'F12');
});

test('the per-second countdown is isolated from the exam session tree', async () => {
  const [examSource, clock, navbar, question, grid, activeView] = await Promise.all([
    readExamSource(),
    source('src/features/exam/examClock.js'),
    source('src/components/ExamNavbar.jsx'),
    source('src/components/QuestionPanel.jsx'),
    source('src/components/GridPanel.jsx'),
    source('src/features/exam/ActiveExamView.jsx')
  ]);

  // No session-level state is updated every second any more.
  assert.doesNotMatch(examSource, /setTimeLeft/);
  assert.match(clock, /useSyncExternalStore/);
  assert.match(clock, /setInterval\(tick, 1000\)/);
  assert.match(clock, /remainingSecondsUntil\(endTime, getExamClockNow\(\)\)/);
  assert.match(examSource, /useDeadlineReached\(sessionEndTime, examState === 'ACTIVE'\)/);
  assert.match(examSource, /confirmSubmitExamRef\.current\?\.\(\)/);

  // The navbar renders the countdown from the fixed deadline and still
  // announces milestones through accessibilityLogic.
  assert.match(activeView, /endTime=\{sessionEndTime\}/);
  assert.match(navbar, /useRemainingSeconds\(endTime\)/);
  assert.match(navbar, /checkTimerMilestones\(/);

  // Heavy panels are memoized and receive stable callbacks.
  assert.match(navbar, /export default memo\(ExamNavbar\)/);
  assert.match(question, /export default memo\(QuestionPanel\)/);
  assert.match(grid, /export default memo\(GridPanel\)/);
  assert.match(examSource, /const setSelectedOption = useCallback\(/);
  assert.match(examSource, /const questionStatuses = useMemo\(/);
  assert.doesNotMatch(activeView, /setSelectedOption=\{\(/);
});

test('autosave and subject timing keep their debounce and interval contracts', async () => {
  const examSource = await readExamSource();
  assert.match(examSource, /executeSave\(userResponses, saveGeneration\);\s*\}, 1000\);/);
  assert.match(examSource, /syncSubjectTime\(\{ onlyIfChanged: true \}\)[\s\S]{0,120}\}, 30000\);/);
  assert.match(examSource, /retryDelayMs\(retry, \{ capMs: 5000 \}\)/);
  assert.match(examSource, /attempt >= 4 \|\| !isTransientRpcError\(submitError/);
});

test('the lockdown warning count is kept per student and attempt, and cleared when the attempt ends', async () => {
  const { readExamWarningCount, saveExamWarningCount, clearOfflineRecoveryRecord } = await import('../src/examLogic.js');
  const values = new Map();
  const storage = {
    getItem: k => (values.has(k) ? values.get(k) : null),
    setItem: (k, v) => { values.set(k, String(v)); },
    removeItem: k => { values.delete(k); }
  };
  const student = { id: 'ABC123', docId: 'uuid-1', name: 'Student' };
  const other = { id: 'XYZ999', docId: 'uuid-2', name: 'Other' };

  assert.equal(readExamWarningCount({ student, examId: 'exam-1', storage }), 0);
  assert.equal(saveExamWarningCount({ student, examId: 'exam-1', storage, count: 2 }), true);
  assert.equal(readExamWarningCount({ student, examId: 'exam-1', storage }), 2);
  assert.equal(readExamWarningCount({ student, examId: 'exam-2', storage }), 0, 'another exam starts at zero');
  assert.equal(readExamWarningCount({ student: other, examId: 'exam-1', storage }), 0, 'another student starts at zero');

  values.set([...values.keys()][0], 'not a number');
  assert.equal(readExamWarningCount({ student, examId: 'exam-1', storage }), 0, 'corrupt values read as zero');

  saveExamWarningCount({ student, examId: 'exam-1', storage, count: 1 });
  clearOfflineRecoveryRecord({ student, examId: 'exam-1', userUuid: student.docId, storage });
  assert.equal(readExamWarningCount({ student, examId: 'exam-1', storage }), 0, 'ending the attempt clears the count');
});

test('only leaving the exam is a counted warning; blocked actions are explained, not counted', async () => {
  const lockdown = await source('src/features/exam/useExamLockdown.js');
  const { MAX_EXAM_WARNINGS, examLeaveReasonText, examWarningConsequenceText } = await import('../src/features/exam/useExamLockdown.js');
  assert.equal(MAX_EXAM_WARNINGS, 2);
  assert.match(examLeaveReasonText('tab'), /another tab, window or app/);
  assert.match(examLeaveReasonText('fullscreen'), /fullscreen/);
  assert.equal(examWarningConsequenceText(1), 'Your exam will end automatically if you leave it 2 more times.');
  assert.equal(examWarningConsequenceText(2), 'Your exam will end automatically if you leave it again.');
  assert.match(lockdown, /handleContextMenu = \(e\) => blockAction\(/);
  assert.match(lockdown, /handleClipboardOrDrag = \(event\) => blockAction\(/);
  assert.match(lockdown, /handleLeave\('tab'\)/);
  assert.match(lockdown, /handleLeave\('fullscreen'\)/);
});
