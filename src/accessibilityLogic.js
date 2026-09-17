/**
 * Accessibility helper functions and definitions for CBT exam interface.
 * Separated into vanilla JS to be directly unit-testable in Node.js test runner.
 */

export const STATUS_GLYPHS = Object.freeze({
  NOT_VISITED: '·',
  NOT_ANSWERED: '—',
  ANSWERED: '✓',
  MARKED: '⚑',
  ANSWERED_MARKED: '✓⚑'
});

export const STATUS_LABELS = Object.freeze({
  NOT_VISITED: 'not visited',
  NOT_ANSWERED: 'not answered',
  ANSWERED: 'answered',
  MARKED: 'marked for review',
  ANSWERED_MARKED: 'answered and marked for review'
});

export const getStatusGlyph = (status) => STATUS_GLYPHS[status] || '·';

export const getStatusLabel = (status) => STATUS_LABELS[status] || 'not visited';

export const TIMER_MILESTONES = Object.freeze([
  { seconds: 3600, label: '60 minutes remaining in examination.' },
  { seconds: 1800, label: '30 minutes remaining in examination.' },
  { seconds: 900, label: '15 minutes remaining in examination.' },
  { seconds: 300, label: 'Warning: 5 minutes remaining in examination.' },
  { seconds: 60, label: 'Urgent: 1 minute remaining in examination.' },
  { seconds: 0, label: 'Time expired. Examination is being submitted.' }
]);

export const checkTimerMilestones = (remainingSeconds, announcedSet, previousSeconds = Number.POSITIVE_INFINITY) => {
  const newlyTriggered = [];
  TIMER_MILESTONES.forEach(({ seconds, label }) => {
    if (previousSeconds > seconds && remainingSeconds <= seconds && !announcedSet.has(seconds)) {
      announcedSet.add(seconds);
      newlyTriggered.push({ seconds, label });
    }
  });
  // A sleeping/background tab may cross several thresholds at once. Mark every
  // crossed threshold, but announce only the most urgent current one.
  return newlyTriggered.length > 0 ? [newlyTriggered[newlyTriggered.length - 1]] : [];
};

// Announcement bridge helpers
let politeHandler = null;
let assertiveHandler = null;

export const registerAnnouncers = (polite, assertive) => {
  politeHandler = polite;
  assertiveHandler = assertive;
};

export const unregisterAnnouncers = () => {
  politeHandler = null;
  assertiveHandler = null;
};

export const announcePolite = (message) => {
  if (politeHandler && message) {
    politeHandler(message);
  }
};

export const announceAssertive = (message) => {
  if (assertiveHandler && message) {
    assertiveHandler(message);
  }
};
