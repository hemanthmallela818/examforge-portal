/**
 * @import {
 *   AutoTableLike, LeaderboardRow, PdfConstructorLike, PdfExportValidation, ResultAnalytics, ResultInput
 * } from './types'
 */

export const MAX_PDF_RESULT_ROWS = 2000;
export const MAX_PDF_TABLE_COLUMNS = 12;

const PDF_ASCII_TEXT = /^[\x20-\x7E]*$/;

/**
 * Strict number coercion: null, undefined, '', booleans and non-finite values throw.
 * @param {unknown} value
 * @param {string} label Used in the error message.
 * @returns {number}
 */
const finiteNumber = (value, label) => {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') {
    throw new Error(`${label} is missing or invalid.`);
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${label} is missing or invalid.`);
  return parsed;
};

/**
 * Trimmed, non-empty, de-duplicated (case-sensitive) subject names.
 * @param {unknown} subjects
 * @returns {string[]}
 */
export const normalizeResultSubjects = (subjects) => {
  /** @type {Set<string>} */
  const seen = new Set();
  return (Array.isArray(subjects) ? subjects : [])
    .map(subject => String(subject ?? '').trim())
    .filter(subject => subject && !seen.has(subject) && seen.add(subject));
};

/**
 * Validates results and assigns competition ranks (1, 1, 3) overall and per subject.
 * Ties are ordered by student ID (numeric-aware).
 * @param {Array<ResultInput | null | undefined>} results
 * @param {unknown} [subjects]
 * @returns {LeaderboardRow[]}
 */
export const buildLeaderboard = (results, subjects = []) => {
  if (!Array.isArray(results)) throw new Error('Result data is invalid.');
  const normalizedSubjects = normalizeResultSubjects(subjects);
  /** @type {Set<string>} */
  const studentIds = new Set();

  const leaderboard = /** @type {LeaderboardRow[]} */ (results.map((result, index) => {
    const rowNumber = index + 1;
    const studentId = String(result?.studentId ?? '').trim();
    const studentName = String(result?.studentName ?? '').trim();
    if (!studentId) throw new Error(`Result row ${rowNumber} has no student ID.`);
    if (!studentName) throw new Error(`Result row ${rowNumber} has no student name.`);
    if (studentIds.has(studentId)) throw new Error(`Duplicate result found for student ${studentId}.`);
    studentIds.add(studentId);

    /** @type {Record<string, number>} */
    const subjectScores = {};
    normalizedSubjects.forEach(subject => {
      const rawScore = result?.subjectScores?.[subject];
      subjectScores[subject] = rawScore === null || rawScore === undefined || rawScore === ''
        ? 0
        : finiteNumber(rawScore, `${subject} score for ${studentId}`);
    });

    return {
      ...result,
      studentId,
      studentName,
      totalScore: finiteNumber(result?.totalScore, `Total score for ${studentId}`),
      maxScore: finiteNumber(result?.maxScore, `Maximum score for ${studentId}`),
      subjectScores,
      subjectRanks: {}
    };
  }));

  leaderboard.sort((left, right) => (
    right.totalScore - left.totalScore
    || left.studentId.localeCompare(right.studentId, 'en', { numeric: true })
  ));

  let totalRank = 0;
  leaderboard.forEach((result, index) => {
    if (index === 0 || result.totalScore !== leaderboard[index - 1].totalScore) totalRank = index + 1;
    result.totalRank = totalRank;
  });

  normalizedSubjects.forEach(subject => {
    const ordered = [...leaderboard].sort((left, right) => (
      right.subjectScores[subject] - left.subjectScores[subject]
      || left.studentId.localeCompare(right.studentId, 'en', { numeric: true })
    ));
    let subjectRank = 0;
    ordered.forEach((result, index) => {
      if (index === 0 || result.subjectScores[subject] !== ordered[index - 1].subjectScores[subject]) {
        subjectRank = index + 1;
      }
      result.subjectRanks[subject] = subjectRank;
    });
  });

  return leaderboard;
};

/**
 * @param {Array<ResultInput | null | undefined>} results
 * @param {unknown} [subjects]
 * @returns {ResultAnalytics | null} null when there are no results.
 */
export const calculateResultAnalytics = (results, subjects = []) => {
  if (!Array.isArray(results) || results.length === 0) return null;
  const normalizedSubjects = normalizeResultSubjects(subjects);
  const normalized = buildLeaderboard(results, normalizedSubjects);
  const scores = normalized.map(result => result.totalScore);
  const sum = scores.reduce((total, score) => total + score, 0);
  const ranges = { '0-20%': 0, '21-40%': 0, '41-60%': 0, '61-80%': 0, '81-100%': 0 };
  let excludedFromDistribution = 0;

  normalized.forEach(result => {
    if (result.maxScore <= 0) {
      excludedFromDistribution += 1;
      return;
    }
    const percentage = (result.totalScore / result.maxScore) * 100;
    if (percentage <= 20) ranges['0-20%'] += 1;
    else if (percentage <= 40) ranges['21-40%'] += 1;
    else if (percentage <= 60) ranges['41-60%'] += 1;
    else if (percentage <= 80) ranges['61-80%'] += 1;
    else ranges['81-100%'] += 1;
  });

  return {
    averageScore: sum / normalized.length,
    highestScore: Math.max(...scores),
    lowestScore: Math.min(...scores),
    distribution: Object.entries(ranges).map(([name, count]) => ({ name, count })),
    excludedFromDistribution,
    subjectAverages: normalizedSubjects.map(subject => ({
      name: subject,
      score: normalized.reduce((total, result) => total + result.subjectScores[subject], 0) / normalized.length
    }))
  };
};

/**
 * Quoted CSV cell with spreadsheet formula-injection protection.
 * @param {unknown} value
 * @returns {string}
 */
const csvTextCell = (value) => {
  let text = String(value ?? '').replace(/[\r\n]+/g, ' ');
  if (/^[\s\u0000-\u001F]*[=+@-]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
};

/**
 * @param {unknown} value
 * @param {string} label
 * @returns {string}
 */
const csvNumberCell = (value, label) => String(finiteNumber(value, label));

/**
 * UTF-8 (BOM) CSV with CRLF line endings.
 * @param {Array<ResultInput | null | undefined>} results
 * @param {unknown} [subjects]
 * @returns {string}
 */
export const buildLeaderboardCsv = (results, subjects = []) => {
  const normalizedSubjects = normalizeResultSubjects(subjects);
  const leaderboard = buildLeaderboard(results, normalizedSubjects);
  if (leaderboard.length === 0) throw new Error('There are no results to export.');

  const headers = ['Total Rank', 'Student Name', 'Student ID'];
  normalizedSubjects.forEach(subject => headers.push(`${subject} Marks`, `${subject} Rank`));
  headers.push('Total Score', 'Max Score');

  const lines = [headers.map(csvTextCell).join(',')];
  leaderboard.forEach(result => {
    const row = [csvNumberCell(result.totalRank, 'Total rank'), csvTextCell(result.studentName), csvTextCell(result.studentId)];
    normalizedSubjects.forEach(subject => row.push(
      csvNumberCell(result.subjectScores[subject], `${subject} score`),
      csvNumberCell(result.subjectRanks[subject], `${subject} rank`)
    ));
    row.push(csvNumberCell(result.totalScore, 'Total score'), csvNumberCell(result.maxScore, 'Maximum score'));
    lines.push(row.join(','));
  });
  return `\uFEFF${lines.join('\r\n')}\r\n`;
};

/**
 * Filesystem-safe base name (no reserved characters or Windows device names).
 * @param {unknown} value
 * @param {unknown} [fallback]
 * @returns {string}
 */
export const safeDownloadName = (value, fallback = 'Exam') => {
  const fallbackName = String(fallback || 'Exam').trim() || 'Exam';
  let cleaned = String(value || fallbackName)
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
    .replace(/[. ]+$/g, '')
    .trim()
    .slice(0, 100);
  if (!cleaned) cleaned = fallbackName;
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(cleaned)) cleaned = `_${cleaned}`;
  return cleaned;
};

/**
 * @param {unknown} results
 * @param {unknown} subjects
 * @param {unknown} examTitle
 * @returns {PdfExportValidation}
 */
export const validatePdfExport = (results, subjects, examTitle) => {
  if (!Array.isArray(results) || results.length === 0) return { ok: false, error: 'There are no results to export.' };
  const normalizedSubjects = normalizeResultSubjects(subjects);
  if (results.length > MAX_PDF_RESULT_ROWS) {
    return { ok: false, error: `PDF export is limited to ${MAX_PDF_RESULT_ROWS} results. Download CSV for larger cohorts.` };
  }
  if (3 + (normalizedSubjects.length * 2) + 1 > MAX_PDF_TABLE_COLUMNS) {
    return { ok: false, error: 'This result table has too many subject columns for a readable PDF. Download CSV instead.' };
  }
  const textValues = [examTitle, ...normalizedSubjects];
  results.forEach(result => textValues.push(result?.studentName, result?.studentId));
  if (textValues.some(value => !PDF_ASCII_TEXT.test(String(value ?? '')))) {
    return { ok: false, error: 'PDF export cannot safely render one or more Unicode names or labels with the installed font. Download the UTF-8 CSV instead.' };
  }
  try {
    return { ok: true, results: buildLeaderboard(results, normalizedSubjects), subjects: normalizedSubjects };
  } catch (error) {
    return { ok: false, error: /** @type {Error} */ (error).message };
  }
};

/**
 * @param {{
 *   PdfConstructor: PdfConstructorLike,
 *   autoTable: AutoTableLike,
 *   results: unknown,
 *   subjects: unknown,
 *   examTitle: unknown,
 *   generatedAt?: Date
 * }} input
 * @returns {{ doc: import('./types').PdfDocumentLike, filename: string }}
 */
export const createLeaderboardPdfDocument = ({
  PdfConstructor,
  autoTable,
  results,
  subjects,
  examTitle,
  generatedAt = new Date()
}) => {
  if (typeof PdfConstructor !== 'function' || typeof autoTable !== 'function') {
    throw new Error('PDF generator is unavailable.');
  }
  const validation = validatePdfExport(results, subjects, examTitle);
  if (!validation.ok) throw new Error(validation.error);

  const doc = new PdfConstructor('l', 'pt', 'a4');
  doc.setFontSize(18);
  doc.setTextColor(15, 23, 42);
  const titleLines = doc.splitTextToSize(`${examTitle} - Leaderboard`, doc.internal.pageSize.getWidth() - 80);
  doc.text(titleLines, 40, 40);

  doc.setFontSize(10);
  doc.setTextColor(100, 116, 139);
  const generatedY = 40 + (titleLines.length * 20);
  doc.text(`Generated on: ${generatedAt.toLocaleString()}`, 40, generatedY);

  const headers = [['Total Rank', 'Student Name', 'Student ID']];
  validation.subjects.forEach(subject => headers[0].push(`${subject} Marks`, `${subject} Rank`));
  headers[0].push('Total Score');

  const data = validation.results.map(result => {
    const row = [result.totalRank, result.studentName, result.studentId];
    validation.subjects.forEach(subject => row.push(result.subjectScores[subject], result.subjectRanks[subject]));
    row.push(`${result.totalScore} / ${result.maxScore}`);
    return row;
  });

  autoTable(doc, {
    head: headers,
    body: data,
    startY: generatedY + 20,
    theme: 'striped',
    headStyles: { fillColor: [37, 99, 235], textColor: [255, 255, 255], fontStyle: 'bold' },
    styles: { fontSize: 9, cellPadding: 8, overflow: 'linebreak' },
    columnStyles: { 0: { halign: 'center' } },
    margin: { top: 40, right: 40, bottom: 35, left: 40 },
    didDrawPage: () => {
      const pageWidth = doc.internal.pageSize.getWidth();
      const pageHeight = doc.internal.pageSize.getHeight();
      doc.setFontSize(8);
      doc.setTextColor(100, 116, 139);
      doc.text(`Page ${doc.getNumberOfPages()}`, pageWidth - 40, pageHeight - 15, { align: 'right' });
    }
  });

  return { doc, filename: `${safeDownloadName(examTitle)}_Leaderboard.pdf` };
};
