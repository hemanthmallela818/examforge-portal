/**
 * Accessibility helper functions and definitions for CBT exam interface.
 * Separated into vanilla JS to be directly unit-testable in Node.js test runner.
 */

/** @import { ResponseStatus } from './types' */

/** @type {Readonly<Record<ResponseStatus, string>>} */
export const STATUS_GLYPHS = Object.freeze({
  NOT_VISITED: '·',
  NOT_ANSWERED: '—',
  ANSWERED: '✓',
  MARKED: '⚑',
  ANSWERED_MARKED: '✓⚑'
});

/** @type {Readonly<Record<ResponseStatus, string>>} */
export const STATUS_LABELS = Object.freeze({
  NOT_VISITED: 'not visited',
  NOT_ANSWERED: 'not answered',
  ANSWERED: 'answered',
  MARKED: 'marked for review',
  ANSWERED_MARKED: 'answered and marked for review'
});

/**
 * @param {ResponseStatus | string | null | undefined} status
 * @returns {string}
 */
export const getStatusGlyph = (status) => STATUS_GLYPHS[/** @type {ResponseStatus} */ (status)] || '·';

/**
 * @param {ResponseStatus | string | null | undefined} status
 * @returns {string}
 */
export const getStatusLabel = (status) => STATUS_LABELS[/** @type {ResponseStatus} */ (status)] || 'not visited';

/** @typedef {{ seconds: number, label: string }} TimerMilestone */

/** @type {ReadonlyArray<TimerMilestone>} */
export const TIMER_MILESTONES = Object.freeze([
  { seconds: 3600, label: '60 minutes remaining in examination.' },
  { seconds: 1800, label: '30 minutes remaining in examination.' },
  { seconds: 900, label: '15 minutes remaining in examination.' },
  { seconds: 300, label: 'Warning: 5 minutes remaining in examination.' },
  { seconds: 60, label: 'Urgent: 1 minute remaining in examination.' },
  { seconds: 0, label: 'Time expired. Examination is being submitted.' }
]);

/**
 * Marks every threshold crossed since `previousSeconds` and returns only the
 * most urgent one (or none).
 * @param {number} remainingSeconds
 * @param {Set<number>} announcedSet Mutated: crossed thresholds are added.
 * @param {number} [previousSeconds]
 * @returns {TimerMilestone[]}
 */
export const checkTimerMilestones = (remainingSeconds, announcedSet, previousSeconds = Number.POSITIVE_INFINITY) => {
  /** @type {TimerMilestone[]} */
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
/** @typedef {(message: string) => void} Announcer */
/** @type {Announcer | null} */
let politeHandler = null;
/** @type {Announcer | null} */
let assertiveHandler = null;

/**
 * @param {Announcer | null} polite
 * @param {Announcer | null} assertive
 */
export const registerAnnouncers = (polite, assertive) => {
  politeHandler = polite;
  assertiveHandler = assertive;
};

export const unregisterAnnouncers = () => {
  politeHandler = null;
  assertiveHandler = null;
};

/** @param {string | null | undefined} message */
export const announcePolite = (message) => {
  if (politeHandler && message) {
    politeHandler(message);
  }
};

/** @param {string | null | undefined} message */
export const announceAssertive = (message) => {
  if (assertiveHandler && message) {
    assertiveHandler(message);
  }
};
