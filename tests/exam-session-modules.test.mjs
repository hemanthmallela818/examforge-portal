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
