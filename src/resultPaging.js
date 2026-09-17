import { parsePagedCollectionResponse } from './paginatedQuery.js';

const finiteNumber = (value, label) => {
  // Strict coercion: null/undefined/''/boolean must NOT silently become 0/1.
  // Mirrors resultExportLogic.js so a malformed server payload fails loudly
  // instead of rendering a fabricated score.
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') {
    throw new Error(`${label} is invalid.`);
  }
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`${label} is invalid.`);
  return number;
};

const validateSubjects = subjects => {
  if (!Array.isArray(subjects)
      || subjects.some(subject => typeof subject !== 'string' || !subject.trim())
      || new Set(subjects).size !== subjects.length) {
    throw new Error('The server returned invalid result subjects.');
  }
  return subjects;
};

const validateSubjectScores = (scores, subjects, studentId) => {
  if (!scores || typeof scores !== 'object' || Array.isArray(scores)) {
    throw new Error('The server returned invalid subject results.');
  }
  for (const subject of subjects) finiteNumber(scores[subject], `${subject} score for ${studentId}`);
  return scores;
};

export const normalizeRankedResultRow = (row, subjects = []) => {
  if (!row || typeof row !== 'object' || Array.isArray(row)) throw new TypeError('The server returned an invalid result row.');
  const studentId = String(row.student_id ?? '').trim();
  const studentName = String(row.student_name ?? '').trim();
  const totalRank = Number(row.total_rank);
  if (!studentId || !studentName || !Number.isInteger(totalRank) || totalRank < 1) throw new Error('The server returned an invalid ranked student.');
  if (!row.subject_ranks || typeof row.subject_ranks !== 'object' || Array.isArray(row.subject_ranks)) {
    throw new Error('The server returned invalid subject results.');
  }
  const subjectScores = validateSubjectScores(row.subject_scores, subjects, studentId);
  for (const subject of subjects) {
    const rank = Number(row.subject_ranks[subject]);
    if (!Number.isInteger(rank) || rank < 1) throw new Error(`The server returned an invalid ${subject} rank for ${studentId}.`);
  }
  return {
    ...row,
    examId: row.exam_id,
    studentId,
    studentName,
    totalScore: finiteNumber(row.total_score, `Total score for ${studentId}`),
    maxScore: finiteNumber(row.max_score, `Maximum score for ${studentId}`),
    subjectScores,
    subjectRanks: row.subject_ranks,
    totalRank
  };
};

export const parseResultPageResponse = (data, options) => {
  const page = parsePagedCollectionResponse(data, options);
  const resultCount = Number(data.result_count);
  if (!Number.isInteger(resultCount) || resultCount < 0 || resultCount < page.total) throw new Error('The server returned an invalid result count.');
  const subjects = validateSubjects(data.subjects);
  if (resultCount > 0 && (!data.analytics || typeof data.analytics !== 'object' || Array.isArray(data.analytics))) throw new Error('The server returned invalid result analytics.');
  if (resultCount === 0 && data.analytics !== null) throw new Error('The server returned analytics for an empty result set.');
  const analytics = data.analytics ? {
    averageScore: finiteNumber(data.analytics.average_score, 'Average score'),
    highestScore: finiteNumber(data.analytics.highest_score, 'Highest score'),
    lowestScore: finiteNumber(data.analytics.lowest_score, 'Lowest score'),
    excludedFromDistribution: Number(data.analytics.excluded_from_distribution),
    distribution: data.analytics.distribution,
    subjectAverages: data.analytics.subject_averages
  } : null;
  if (analytics && (!Number.isInteger(analytics.excludedFromDistribution) || analytics.excludedFromDistribution < 0
      || !Array.isArray(analytics.distribution) || !Array.isArray(analytics.subjectAverages))) {
    throw new Error('The server returned malformed result analytics.');
  }
  if (analytics) {
    const distributionNames = ['0-20%', '21-40%', '41-60%', '61-80%', '81-100%'];
    const validDistribution = analytics.distribution.length === distributionNames.length
      && analytics.distribution.every((item, index) => item && typeof item === 'object' && !Array.isArray(item)
        && item.name === distributionNames[index] && Number.isInteger(Number(item.count)) && Number(item.count) >= 0);
    const distributedCount = validDistribution
      ? analytics.distribution.reduce((sum, item) => sum + Number(item.count), 0)
      : -1;
    const validSubjectAverages = analytics.subjectAverages.length === subjects.length
      && analytics.subjectAverages.every((item, index) => item && typeof item === 'object' && !Array.isArray(item)
        && item.name === subjects[index] && Number.isFinite(finiteNumber(item.score, `${subjects[index]} average score`)));
    if (!validDistribution || distributedCount + analytics.excludedFromDistribution !== resultCount
        || !validSubjectAverages || analytics.highestScore < analytics.lowestScore
        || analytics.averageScore < analytics.lowestScore || analytics.averageScore > analytics.highestScore) {
      throw new Error('The server returned inconsistent result analytics.');
    }
  }
  const rows = page.rows.map(row => normalizeRankedResultRow(row, subjects));
  if (new Set(rows.map(row => row.id)).size !== rows.length || new Set(rows.map(row => row.studentId)).size !== rows.length) {
    throw new Error('The result page contains duplicate students.');
  }
  return { ...page, resultCount, subjects, analytics, rows };
};

const normalizeExportResultRow = (row, subjects) => {
  if (!row || typeof row !== 'object' || Array.isArray(row)) throw new TypeError('The server returned an invalid export row.');
  const studentId = String(row.student_id ?? '').trim();
  const studentName = String(row.student_name ?? '').trim();
  if (!row.id || !studentId || !studentName) {
    throw new Error('The server returned an invalid export result.');
  }
  const subjectScores = validateSubjectScores(row.subject_scores, subjects, studentId);
  return {
    ...row,
    examId: row.exam_id,
    studentId,
    studentName,
    totalScore: finiteNumber(row.total_score, `Total score for ${studentId}`),
    maxScore: finiteNumber(row.max_score, `Maximum score for ${studentId}`),
    subjectScores
  };
};

export const parseResultExportPageResponse = (data, { expectedCount, pageSize, afterCursor }) => {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new TypeError('The server returned an invalid export page.');
  if (Number(data.result_count) !== expectedCount || !Array.isArray(data.rows) || data.rows.length > pageSize) {
    throw new Error('The result set changed while the export was being prepared. Retry the export.');
  }
  if (typeof data.has_more !== 'boolean') {
    throw new Error('The server returned invalid export metadata.');
  }
  const subjects = validateSubjects(data.subjects);
  const rows = data.rows.map(row => normalizeExportResultRow(row, subjects));
  if (rows.length > 0 && afterCursor !== null && afterCursor !== undefined && rows[0].studentId === afterCursor) {
    throw new Error('The export cursor did not advance. Retry the export.');
  }
  if (new Set(rows.map(row => row.studentId)).size !== rows.length) throw new Error('The export page contains duplicate students.');
  const expectedCursor = rows.length > 0 ? rows[rows.length - 1].studentId : null;
  if (data.next_student_id !== expectedCursor || (data.has_more && (rows.length !== pageSize || !expectedCursor))) {
    throw new Error('The server returned an invalid export cursor.');
  }
  return { resultCount: expectedCount, subjects, rows, hasMore: data.has_more, nextCursor: expectedCursor };
};

export const validateCompleteResultExport = (pages, expectedCount) => {
  if (!Array.isArray(pages)) throw new TypeError('Export pages are invalid.');
  const rows = pages.flat();
  if (!Number.isInteger(expectedCount) || expectedCount < 1 || rows.length !== expectedCount) throw new Error('The complete result set was not retrieved.');
  const ids = rows.map(row => row.id);
  const studentIds = rows.map(row => row.studentId);
  if (ids.some(id => !id) || new Set(ids).size !== ids.length || new Set(studentIds).size !== studentIds.length) {
    throw new Error('The result set changed while the export was being prepared. Retry the export.');
  }
  return rows;
};
