import { sameResponses } from '../src/examLogic.js';

// Confirm answers in the delivered paper order, which differs for every attempt.
export const responsesForPaper = (paper, responses) => {
  const byId = new Map(responses.map(response => [response.question_id, response]));
  return Object.fromEntries(Object.entries(paper.questions).map(([subject, questions]) => [subject,
    questions.map(question => {
      const response = byId.get(question.id);
      if (!response) throw new Error(`Missing rehearsal answer for question ${question.id}.`);
      return { selectedOption: response.selected_option, status: response.status };
    })
  ]));
};

// Completion scheduling mirrors the student screen: saves postpone reads, failures back off.
export const nextStudentPollAt = (completedAt, interval, failures = 0, random = Math.random) =>
  completedAt + (failures ? Math.min(120_000, interval.max * (2 ** failures))
    : interval.min + Math.floor(random() * (interval.max - interval.min + 1)));

export const timingFallbackDue = (now, lastSavedAt, changed) => changed && now - lastSavedAt >= 60_000;

export const projectUsage = ({ responseBytes, databaseBefore, databaseAfter, sittingsPerMonth }) => ({
  responsePayloadBytes: responseBytes,
  projectedMonthlyResponsePayloadBytes: responseBytes * sittingsPerMonth,
  databaseBytes: databaseAfter ?? null,
  observedDatabaseGrowthBytes: databaseBefore == null || databaseAfter == null ? null : Math.max(0, databaseAfter - databaseBefore),
  projectedMonthlyDatabaseGrowthBytes: databaseBefore == null || databaseAfter == null ? null
    : Math.max(0, databaseAfter - databaseBefore) * sittingsPerMonth
});

// Only repeated, threshold-enforced hosted Free-tier evidence can establish an operating limit.
export const operatingCapacity = (reports, requiredRepeats = 3) => {
  const passing = new Map();
  for (const report of reports) {
    if (!report.passed || report.environment !== 'hosted-free' || !report.load?.thresholds?.enforced
        || !report.load.thresholds.passed || !report.fullDurationValidated || !report.representativeMediaValidated
        || !report.operationalDrillsValidated || !report.runId || !report.projectRef) continue;
    const requiredLimits = { dashboard_read: 2000, autosave: 1000, final_sync: 1000, start: 3000, submit: 3000 };
    if (report.load.thresholds.config?.maxErrorRate > 0.01 || Object.entries(requiredLimits).some(([operation, limit]) => {
      const measured = report.load.operations?.[operation];
      return !measured?.samples || measured.p95 > limit || measured.errors / measured.samples > 0.01;
    })) continue;
    const concurrency = report.load?.config?.workerConcurrency;
    if (!Number.isInteger(concurrency) || concurrency < 1) continue;
    const key = `${report.projectRef}:${concurrency}`;
    if (!passing.has(key)) passing.set(key, { concurrency, runs: new Set() });
    passing.get(key).runs.add(report.runId);
  }
  const highest = Math.max(0, ...[...passing.values()].filter(entry => entry.runs.size >= requiredRepeats).map(entry => entry.concurrency));
  return { requiredRepeats, highestRepeatedlyPassingConcurrency: highest || null, operatingCohort: highest ? Math.floor(highest * 0.7) : null };
};

// Identical server answers confirm a lost save response even when the version advanced.
export const isConfirmedSaveReply = (data, payload) => Boolean(data?.success
  || (data?.conflict && data.user_responses && sameResponses(data.user_responses, payload)));
