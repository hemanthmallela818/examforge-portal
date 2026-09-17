import test from 'node:test';
import assert from 'node:assert/strict';
import {
  STATUS_GLYPHS,
  STATUS_LABELS,
  getStatusGlyph,
  getStatusLabel,
  TIMER_MILESTONES,
  checkTimerMilestones,
  registerAnnouncers,
  unregisterAnnouncers,
  announcePolite,
  announceAssertive
} from '../src/accessibilityLogic.js';
import { FOCUSABLE_SELECTOR } from '../src/dialogFocus.js';
import { isNarrowViewport, checkBrowserCompatibility } from '../src/runtimeConfig.js';

test('status accessibility: provides color-independent glyphs and unambiguous screen reader labels', () => {
  const allStatuses = ['NOT_VISITED', 'NOT_ANSWERED', 'ANSWERED', 'MARKED', 'ANSWERED_MARKED'];
  
  for (const status of allStatuses) {
    const glyph = getStatusGlyph(status);
    const label = getStatusLabel(status);
    assert.ok(glyph, `Glyph must be present for ${status}`);
    assert.ok(label, `Label must be present for ${status}`);
    assert.equal(typeof glyph, 'string');
    assert.equal(typeof label, 'string');
    assert.notEqual(glyph.trim(), '');
    assert.notEqual(label.trim(), '');
  }

  // Fallback for unknown status
  assert.equal(getStatusGlyph('UNKNOWN_STATUS'), '·');
  assert.equal(getStatusLabel('UNKNOWN_STATUS'), 'not visited');
});

test('timer milestones: announces urgent threshold and prevents announcement flood after tab sleep', () => {
  const announced = new Set();

  // 1. Candidate at 3601s -> 3600s: triggers 60m milestone
  const m1 = checkTimerMilestones(3600, announced, 3601);
  assert.equal(m1.length, 1);
  assert.match(m1[0].label, /60 minutes remaining/);
  assert.equal(announced.has(3600), true);

  // 2. Candidate still at 3599s: no new milestone
  const m2 = checkTimerMilestones(3599, announced, 3600);
  assert.equal(m2.length, 0);

  // 3. TAB SLEEP SCENARIO: Laptop lid closed at 1000s, opened at 50s!
  // Crossed 900s (15m), 300s (5m), and 60s (1m) simultaneously.
  const mSleep = checkTimerMilestones(50, announced, 1000);
  // Must announce ONLY the single most urgent threshold (60s)
  assert.equal(mSleep.length, 1);
  assert.equal(mSleep[0].seconds, 60);
  assert.match(mSleep[0].label, /Urgent: 1 minute remaining/);
  // All three thresholds must be marked announced so they don't fire late
  assert.equal(announced.has(900), true);
  assert.equal(announced.has(300), true);
  assert.equal(announced.has(60), true);

  // 4. Timer expires at 0s
  const mZero = checkTimerMilestones(0, announced, 10);
  assert.equal(mZero.length, 1);
  assert.equal(mZero[0].seconds, 0);
  assert.match(mZero[0].label, /Time expired/);
});

test('announcement bridge: safely manages life cycle and routes messages', () => {
  // Safe execution when unmounted
  unregisterAnnouncers();
  assert.doesNotThrow(() => announcePolite('Test polite message'));
  assert.doesNotThrow(() => announceAssertive('Test assertive message'));

  // Registration & routing
  const politeMessages = [];
  const assertiveMessages = [];
  registerAnnouncers(
    msg => politeMessages.push(msg),
    msg => assertiveMessages.push(msg)
  );

  announcePolite('Saving answers...');
  announceAssertive('Security Warning: Fullscreen exited.');

  assert.equal(politeMessages.length, 1);
  assert.equal(politeMessages[0], 'Saving answers...');
  assert.equal(assertiveMessages.length, 1);
  assert.equal(assertiveMessages[0], 'Security Warning: Fullscreen exited.');

  // Clean teardown
  unregisterAnnouncers();
  announcePolite('Should not be received');
  assert.equal(politeMessages.length, 1);
});

test('dialog focusable selector: adheres to HTML keyboard accessibility specifications', () => {
  assert.ok(FOCUSABLE_SELECTOR.includes('button:not([disabled])'));
  assert.ok(FOCUSABLE_SELECTOR.includes('input:not([disabled])'));
  assert.ok(FOCUSABLE_SELECTOR.includes('select:not([disabled])'));
  assert.ok(FOCUSABLE_SELECTOR.includes('textarea:not([disabled])'));
  assert.ok(FOCUSABLE_SELECTOR.includes('a[href]'));
  assert.ok(FOCUSABLE_SELECTOR.includes('[tabindex]:not([tabindex="-1"])'));
});

test('device viewport & compatibility: enforces mobile restriction breakpoint and runtime APIs', () => {
  // Mobile / Narrow viewport check (< 768px)
  assert.equal(isNarrowViewport(320), true);  // Small phone
  assert.equal(isNarrowViewport(480), true);  // Large phone
  assert.equal(isNarrowViewport(767), true);  // Just below breakpoint
  assert.equal(isNarrowViewport(768), false); // Tablet portrait
  assert.equal(isNarrowViewport(1024), false);// Desktop / Tablet landscape
  assert.equal(isNarrowViewport(1920), false);// Full HD Monitor

  // Browser compatibility checker
  const compat = checkBrowserCompatibility();
  assert.ok(compat);
  assert.equal(typeof compat.compatible, 'boolean');
  assert.ok(Array.isArray(compat.missingFeatures));
  assert.ok(compat.supportedEnvironments);
});
