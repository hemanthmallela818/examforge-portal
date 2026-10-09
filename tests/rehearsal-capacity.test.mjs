import test from 'node:test';
import assert from 'node:assert/strict';
import { isTransientRpcError, retryDelayMs } from '../src/examLogic.js';
import { nextStudentPollAt, timingFallbackDue, projectUsage, operatingCapacity, isConfirmedSaveReply, responsesForPaper } from '../scripts/rehearsal-capacity.mjs';

test('Rehearsal saves match shuffled paper IDs and reject missing answers', () => {
  const paper = { questions: { Physics: [{ id: 'q2' }, { id: 'q1' }] } };
  const answers = [{ question_id: 'q1', selected_option: '1', status: 'ANSWERED' },
    { question_id: 'q2', selected_option: '2', status: 'ANSWERED_MARKED' }];
  assert.deepEqual(responsesForPaper(paper, answers), { Physics: [
    { selectedOption: '2', status: 'ANSWERED_MARKED' }, { selectedOption: '1', status: 'ANSWERED' }
  ] });
  assert.throws(() => responsesForPaper(paper, answers.slice(0, 1)), /Missing rehearsal answer/);
});

test('Polls follow completion with 20–30 second jitter, save postponement and capped failure backoff', () => {
  const interval = { min: 20_000, max: 30_000 };
  assert.equal(nextStudentPollAt(5_000, interval, 0, () => 0), 25_000);
  assert.equal(nextStudentPollAt(5_000, interval, 0, () => 0.999999), 35_000);
  assert.equal(nextStudentPollAt(25_000, interval, 0, () => 0), 45_000);
  assert.equal(nextStudentPollAt(5_000, interval, 1), 65_000);
  assert.equal(nextStudentPollAt(5_000, interval, 8), 125_000);
});

test('Changed timing fallback waits sixty seconds after any successful timing save', () => {
  assert.equal(timingFallbackDue(59_999, 0, true), false);
  assert.equal(timingFallbackDue(60_000, 0, true), true);
  assert.equal(timingFallbackDue(120_000, 0, false), false);
  assert.equal(timingFallbackDue(70_000, 65_000, true), false);
});

test('Usage projection retains missing observations and never treats cleanup as negative growth', () => {
  assert.deepEqual(projectUsage({ responseBytes: 500, databaseBefore: 100, databaseAfter: 150, sittingsPerMonth: 4 }), {
    responsePayloadBytes: 500, projectedMonthlyResponsePayloadBytes: 2000,
    databaseBytes: 150, observedDatabaseGrowthBytes: 50, projectedMonthlyDatabaseGrowthBytes: 200
  });
  assert.equal(projectUsage({ responseBytes: 0, databaseBefore: 100, databaseAfter: 80, sittingsPerMonth: 4 }).observedDatabaseGrowthBytes, 0);
  assert.equal(projectUsage({ responseBytes: 0, sittingsPerMonth: 4 }).projectedMonthlyDatabaseGrowthBytes, null);
});

test('Operating cohort requires unique repeated same-project hosted Free full-duration passes with every gate', () => {
  const pass = (runId, workerConcurrency = 100) => ({
    passed: true, environment: 'hosted-free', projectRef: 'disposable', runId,
    fullDurationValidated: true, representativeMediaValidated: true, operationalDrillsValidated: true,
    load: { config: { workerConcurrency }, thresholds: { passed: true, enforced: true, config: { maxErrorRate: 0.01 } },
      operations: Object.fromEntries(['dashboard_read', 'autosave', 'final_sync', 'start', 'submit'].map(name => [name, { samples: 100, errors: 0, p95: 999 }])) }
  });
  const reports = [pass('a'), pass('a'), pass('b')];
  assert.equal(operatingCapacity(reports).operatingCohort, null);
  reports.push(pass('c'));
  assert.equal(operatingCapacity(reports).operatingCohort, 70);
  reports.push(...['d', 'e', 'f'].map(id => ({ ...pass(id, 300), environment: 'local' })));
  reports.push(...['g', 'h', 'i'].map(id => ({ ...pass(id, 300), representativeMediaValidated: false })));
  reports.push(...['j', 'k', 'l'].map(id => ({ ...pass(id, 300), projectRef: id })));
  assert.equal(operatingCapacity(reports).highestRepeatedlyPassingConcurrency, 100);
  const relaxed = pass('relaxed', 300);
  relaxed.load.operations.autosave.p95 = 1001;
  assert.equal(operatingCapacity([relaxed], 1).operatingCohort, null);
  assert.equal(operatingCapacity([pass('a', 3), pass('b', 3), pass('c', 3)]).operatingCohort, 2);
});


test('Lost save response confirms identical server answers without accepting another tab’s payload', () => {
  const payload = { Physics: [{ selectedOption: '1', status: 'ANSWERED' }] };
  assert.equal(isConfirmedSaveReply({ success: true, version: 2 }, payload), true);
  assert.equal(isConfirmedSaveReply({ conflict: true, version: 2, user_responses: { Physics: [{ status: 'ANSWERED', selectedOption: '1' }] } }, payload), true);
  assert.equal(isConfirmedSaveReply({ conflict: true, version: 2, user_responses: { Physics: [{ selectedOption: '2', status: 'ANSWERED' }] } }, payload), false);
  assert.equal(isConfirmedSaveReply({ conflict: true, version: 2 }, payload), false);
  assert.equal(isConfirmedSaveReply(null, payload), false);
});

test('Rehearsal shares frontend overload retries and capped jitter while refusing business-error retries', () => {
  assert.equal(isTransientRpcError({ httpStatus: 503, message: 'Service unavailable' }), true);
  assert.equal(isTransientRpcError({ code: '40001', message: 'Serialization failure' }), true);
  assert.equal(isTransientRpcError({ code: 'PGRST003', message: 'Pool exhausted' }), true);
  assert.equal(isTransientRpcError({ code: 'EX015', httpStatus: 400, message: 'Session access generation mismatch' }), false);
  assert.equal(retryDelayMs(1, { capMs: 5000, random: () => 0 }), 500);
  assert.equal(retryDelayMs(4, { capMs: 5000, random: () => 1 }), 5000);
});
