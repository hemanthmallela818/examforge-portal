// A single shared one-second exam clock exposed through useSyncExternalStore.
//
// The countdown used to live in App state, so every tick re-rendered the whole
// exam tree. Now only subscribers re-render: the timer text subscribes to the
// remaining seconds, and the session subscribes to a boolean "deadline
// reached" snapshot that changes exactly once.
import { useSyncExternalStore } from 'react';
import { remainingSecondsUntil } from '../../examLogic';

/** @type {Set<() => void>} */
const listeners = new Set();
let lastTick = Date.now();
/** @type {ReturnType<typeof setInterval> | null} */
let intervalId = null;

const tick = () => {
  lastTick = Date.now();
  listeners.forEach(listener => listener());
};

/** @param {() => void} listener */
export const subscribeExamClock = (listener) => {
  listeners.add(listener);
  if (intervalId === null) {
    lastTick = Date.now();
    intervalId = setInterval(tick, 1000);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && intervalId !== null) {
      clearInterval(intervalId);
      intervalId = null;
    }
  };
};

const noopSubscribe = () => () => {};

// While ticking, every subscriber reads the same instant so the timer text and
// the deadline check can never disagree. While idle, read the wall clock so a
// newly mounted subscriber never starts from a stale instant.
export const getExamClockNow = () => (intervalId === null ? Date.now() : lastTick);

/**
 * Seconds remaining until `endTime` (epoch ms), re-rendering once per second.
 * The value is derived from the fixed end time, so sleep, background
 * throttling, or a busy main thread cannot give the candidate extra time.
 * @param {number | null | undefined} endTime
 * @returns {number | null}
 */
export function useRemainingSeconds(endTime) {
  return useSyncExternalStore(
    endTime ? subscribeExamClock : noopSubscribe,
    () => (endTime ? remainingSecondsUntil(endTime, getExamClockNow()) : null)
  );
}

/**
 * True once `endTime` has passed. Re-renders the caller only when the value flips.
 * @param {number | null | undefined} endTime
 * @param {boolean} enabled
 * @returns {boolean}
 */
export function useDeadlineReached(endTime, enabled) {
  const active = Boolean(enabled && endTime);
  return useSyncExternalStore(
    active ? subscribeExamClock : noopSubscribe,
    () => active && remainingSecondsUntil(endTime, getExamClockNow()) === 0
  );
}
