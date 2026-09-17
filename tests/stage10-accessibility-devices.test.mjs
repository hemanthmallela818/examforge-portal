import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  checkBrowserCompatibility,
  isNarrowViewport,
  SUPPORTED_ENVIRONMENTS
} from '../src/runtimeConfig.js';
import {
  getStatusGlyph,
  getStatusLabel,
  checkTimerMilestones,
  TIMER_MILESTONES,
  announcePolite,
  announceAssertive,
  registerAnnouncers,
  unregisterAnnouncers
} from '../src/accessibilityLogic.js';

test('browser compatibility checker correctly verifies modern Web APIs and detects deficiencies', () => {
  // 1. Fully compliant environment
  const mockModernEnv = {
    crypto: { randomUUID: () => '12345678-1234-4234-8234-123456789012' },
    localStorage: new Map(),
    sessionStorage: new Map(),
    fetch: async () => ({ ok: true }),
    Intl: { DateTimeFormat: () => {} }
  };
  for (const name of ['localStorage', 'sessionStorage']) {
    const values = mockModernEnv[name];
    values.setItem = (key, value) => values.set(key, value);
    values.getItem = (key) => values.get(key) ?? null;
    values.removeItem = (key) => values.delete(key);
  }

  const modernResult = checkBrowserCompatibility(mockModernEnv);
  assert.equal(modernResult.compatible, true, 'Modern environment should pass compatibility checks');
  assert.deepEqual(modernResult.missingFeatures, [], 'No missing features should be detected');
  assert.ok(modernResult.supportedEnvironments.desktop.length >= 4, 'Desktop environments specified');
  assert.ok(modernResult.supportedEnvironments.mobile.length >= 3, 'Mobile environments specified');

  // 2. Deficient environment (e.g., missing crypto.randomUUID or localStorage)
  const mockDeficientEnv = {
    crypto: {},
    sessionStorage: { getItem: () => null },
    fetch: async () => ({ ok: true })
  };

  const deficientResult = checkBrowserCompatibility(mockDeficientEnv);
  assert.equal(deficientResult.compatible, false, 'Deficient environment should fail compatibility check');
  assert.ok(
    deficientResult.missingFeatures.some(f => f.includes('crypto.randomUUID')),
    'Should report missing crypto.randomUUID'
  );
  assert.ok(
    deficientResult.missingFeatures.some(f => f.includes('localStorage')),
    'Should report missing localStorage'
  );
  assert.ok(
    deficientResult.missingFeatures.some(f => f.includes('Intl')),
    'Should report missing Intl'
  );

  const quotaBlockedStorage = {
    getItem: () => null,
    setItem: () => { throw new DOMException('Quota exceeded', 'QuotaExceededError'); },
    removeItem: () => {}
  };
  const blockedResult = checkBrowserCompatibility({
    ...mockModernEnv,
    localStorage: quotaBlockedStorage
  });
  assert.equal(blockedResult.compatible, false, 'A browser with unusable local storage must be blocked');
  assert.ok(blockedResult.missingFeatures.some(f => /localStorage.*blocked|full|unavailable/i.test(f)));
});

test('viewport width classifier enforces narrow device breakpoint below 768px', () => {
  assert.equal(isNarrowViewport(320), true, '320px mobile should be classified as narrow viewport');
  assert.equal(isNarrowViewport(375), true, '375px iPhone should be classified as narrow viewport');
  assert.equal(isNarrowViewport(767), true, '767px should be classified as narrow viewport');
  assert.equal(isNarrowViewport(768), false, '768px tablet portrait should not be narrow viewport');
  assert.equal(isNarrowViewport(1024), false, '1024px desktop/tablet landscape should not be narrow');
  assert.equal(isNarrowViewport(1440), false, '1440px desktop should not be narrow');
});

test('status glyphs and screen-reader labels provide color-independent state discrimination', () => {
  const statuses = [
    { key: 'NOT_VISITED', glyph: '·', label: 'not visited' },
    { key: 'NOT_ANSWERED', glyph: '—', label: 'not answered' },
    { key: 'ANSWERED', glyph: '✓', label: 'answered' },
    { key: 'MARKED', glyph: '⚑', label: 'marked for review' },
    { key: 'ANSWERED_MARKED', glyph: '✓⚑', label: 'answered and marked for review' }
  ];

  statuses.forEach(({ key, glyph, label }) => {
    assert.equal(getStatusGlyph(key), glyph, `Glyph for ${key} must match`);
    assert.equal(getStatusLabel(key), label, `Label for ${key} must match`);
  });

  // Verify unknown fallback
  assert.equal(getStatusGlyph('UNKNOWN_STATUS'), '·');
  assert.equal(getStatusLabel('UNKNOWN_STATUS'), 'not visited');

  // Verify all glyphs are distinct from each other
  const allGlyphs = statuses.map(s => s.glyph);
  const uniqueGlyphs = new Set(allGlyphs);
  assert.equal(uniqueGlyphs.size, statuses.length, 'Every status must have a visually distinct glyph');
});

test('LiveAnnouncer module exports safe functions that do not crash when unmounted', () => {
  assert.doesNotThrow(() => {
    announcePolite('Test polite announcement without mounted component');
  });

  assert.doesNotThrow(() => {
    announceAssertive('Test assertive announcement without mounted component');
  });
});

test('LiveAnnouncer registration bridge routes messages to registered callbacks', () => {
  const politeMessages = [];
  const assertiveMessages = [];

  registerAnnouncers(
    (msg) => politeMessages.push(msg),
    (msg) => assertiveMessages.push(msg)
  );

  announcePolite('Test polite 1');
  announceAssertive('Test assertive 1');

  assert.deepEqual(politeMessages, ['Test polite 1']);
  assert.deepEqual(assertiveMessages, ['Test assertive 1']);

  unregisterAnnouncers();

  announcePolite('Test polite 2 (after unregister)');
  announceAssertive('Test assertive 2 (after unregister)');

  // Count should not increase after unregistering
  assert.equal(politeMessages.length, 1);
  assert.equal(assertiveMessages.length, 1);
});

test('checkTimerMilestones triggers milestones exactly once and respects priority', () => {
  const announced = new Set();

  // Test starting at 3700 seconds (over 60m): nothing triggered yet
  let triggered = checkTimerMilestones(3700, announced);
  assert.equal(triggered.length, 0);

  // Cross 60m (3600s)
  triggered = checkTimerMilestones(3600, announced);
  assert.equal(triggered.length, 1);
  assert.equal(triggered[0].seconds, 3600);
  assert.match(triggered[0].label, /60 minutes/);

  // Calling again at 3590s does not re-trigger 60m
  triggered = checkTimerMilestones(3590, announced);
  assert.equal(triggered.length, 0);

  // Drop to 4 minutes (240s): all crossed thresholds are recorded, but only
  // the most urgent current milestone is announced.
  triggered = checkTimerMilestones(240, announced);
  assert.equal(triggered.length, 1);
  assert.deepEqual(triggered.map(t => t.seconds), [300]);

  // Drop to 0: both remaining milestones are recorded; expiry wins the alert.
  triggered = checkTimerMilestones(0, announced);
  assert.equal(triggered.length, 1);
  assert.deepEqual(triggered.map(t => t.seconds), [0]);
  assert.match(triggered[0].label, /expired/);

  // Mounting exactly on a threshold does not announce a stale milestone.
  assert.deepEqual(checkTimerMilestones(1800, new Set(), 1800), []);

  // All 6 milestones now in set
  assert.equal(announced.size, TIMER_MILESTONES.length);
});

test('CSS includes high contrast mode (forced-colors) and screen-reader skip link rules', () => {
  const cssPath = resolve('src/index.css');
  const css = readFileSync(cssPath, 'utf8');

  // 1. High contrast / forced-colors media query
  assert.match(
    css,
    /@media\s*\(\s*forced-colors:\s*active\s*\)/i,
    'index.css must declare @media (forced-colors: active) for Windows High Contrast / WCAG'
  );

  // 2. Status borders in forced-colors mode
  assert.match(css, /\.status-not-visited\s*\{[^}]*dashed/i, 'not-visited must have dashed border');
  assert.match(css, /\.status-not-answered\s*\{[^}]*solid/i, 'not-answered must have solid border');
  assert.match(css, /\.status-answered\s*\{[^}]*solid/i, 'answered must have solid/highlight border');
  assert.match(css, /\.status-marked\s*\{[^}]*dotted/i, 'marked must have dotted border');
  assert.match(css, /\.status-answered-marked\s*\{[^}]*double/i, 'answered-marked must have double border');

  // 3. Screen-reader skip navigation classes
  assert.match(css, /\.sr-only\b/, 'index.css must include .sr-only utility class');
  assert.match(css, /\.sr-skip-nav\b/, 'index.css must include .sr-skip-nav utility class');
  assert.match(css, /\.sr-skip-link\b/, 'index.css must include .sr-skip-link utility class');
  assert.match(css, /\.sr-skip-link:focus\b/, 'index.css must define visible :focus state for .sr-skip-link');

  // 4. Focus-visible styling
  assert.match(css, /:focus-visible\s*\{[^}]*outline:/i, ':focus-visible must define clear outline');

  // 5. Mobile touch target sizes (min 44px)
  assert.match(css, /min-height:\s*44px/i, 'index.css must enforce 44px min-height for mobile touch targets');
  assert.match(css, /\.responsive-two-column-grid\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/i,
    'two-column authoring layouts must collapse to one column on narrow screens');
});

test('long-running question imports use a trapped semantic dialog and progressbar', () => {
  const source = readFileSync(resolve('src/components/AIQuestionImporter.jsx'), 'utf8');
  assert.match(source, /<AccessibleModal\s+labelledBy="question-import-progress-title"/);
  assert.match(source, /role="progressbar"/);
  assert.match(source, /aria-valuenow=\{importProgress\}/);
});

test('supported environments matrix satisfies Stage 10 browser & OS specification', () => {
  const { desktop, mobile, operatingSystems } = SUPPORTED_ENVIRONMENTS;

  // Verify Chrome, Edge, Firefox, Safari versions
  const chrome = desktop.find(d => d.browser.includes('Chrome'));
  const edge = desktop.find(d => d.browser.includes('Edge'));
  const firefox = desktop.find(d => d.browser.includes('Firefox'));
  const safari = desktop.find(d => d.browser.includes('Safari'));

  assert.ok(chrome && chrome.minVersion === '90+', 'Chrome 90+ must be supported');
  assert.ok(edge && edge.minVersion === '90+', 'Edge 90+ must be supported');
  assert.ok(firefox && firefox.minVersion === '90+', 'Firefox 90+ must be supported');
  assert.ok(safari && safari.minVersion === '15+', 'Safari 15+ must be supported');

  // Operating systems
  assert.ok(operatingSystems.some(os => os.includes('Windows 10 / 11')));
  assert.ok(operatingSystems.some(os => os.includes('macOS 12')));
  assert.ok(operatingSystems.some(os => os.includes('Android 10')));
  assert.ok(operatingSystems.some(os => os.includes('iOS / iPadOS 15')));
});
