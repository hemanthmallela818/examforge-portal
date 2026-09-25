import { resolveAllowedSubjects } from './importLogic.js';

/** @import { LatexCheck, PreflightResult, UntrustedInput } from './types' */

/**
 * @param {unknown} text
 * @returns {LatexCheck}
 */
export const checkLatexDelimiters = (text) => {
  if (!text || typeof text !== 'string') return { balanced: true };
  
  // Remove escaped dollar signs
  const sanitized = text.replace(/\\\$/g, '');
  
  // Count $$ occurrences
  const doubleMatches = sanitized.match(/\$\$/g) || [];
  if (doubleMatches.length % 2 !== 0) {
    return { balanced: false, reason: 'Unmatched display math delimiter ($$)' };
  }
  
  // Replace $$ with spaces so we can count isolated single $
  const withoutDoubles = sanitized.replace(/\$\$/g, '  ');
  const singleMatches = withoutDoubles.match(/\$/g) || [];
  if (singleMatches.length % 2 !== 0) {
    return { balanced: false, reason: 'Unmatched inline math delimiter ($)' };
  }

  return { balanced: true };
};

/**
 * Validates an exam (metadata + question paper) before publishing.
 * @param {UntrustedInput} exam Exam row, optionally with `questions_data`.
 * @param {{ knownSubjects?: unknown }} [options]
 * @returns {PreflightResult}
 */
export const validateExamPreflight = (exam, options = {}) => {
  // Existing exams may use subjects that were later deactivated; pass every
  // configured subject (active or not) as `knownSubjects`.
  const knownSubjects = resolveAllowedSubjects(options.knownSubjects).map(subject => subject.toLocaleLowerCase());
  /** @type {string[]} */
  const errors = [];
  /** @type {string[]} */
  const warnings = [];
  /** @type {Set<string>} */
  const storageAssets = new Set();
  /** @type {Set<string>} */
  const externalAssets = new Set();
  /** @type {Set<string>} */
  const insecureAssets = new Set();
  /** @type {Record<string, number>} */
  const subjectCounts = {};

  if (!exam || typeof exam !== 'object') {
    return {
      valid: false,
      errors: ['Exam data is missing or invalid.'],
      warnings: [],
      stats: { totalQuestions: 0, subjectCounts: {}, storageAssetCount: 0, externalAssetCount: 0 },
      storageAssets: []
    };
  }

  // 1. Metadata Validation
  const title = String(exam.title || '').trim();
  if (!title || title.length < 1 || title.length > 200) {
    errors.push('Exam title must be between 1 and 200 characters.');
  }

  const className = String(exam.class || '').trim();
  const sectionName = String(exam.section || '').trim();
  if (!className) {
    errors.push('Target Class is required.');
  }
  if (!sectionName) {
    errors.push('Target Section is required.');
  }

  const qdata = exam.questions_data || exam;
  const duration = Number(qdata.duration);
  if (!Number.isInteger(duration) || duration < 1 || duration > 600) {
    errors.push('Duration must be an integer between 1 and 600 minutes.');
  }

  const marksCorrect = Number(qdata.marksCorrect);
  if (isNaN(marksCorrect) || marksCorrect < 0 || marksCorrect > 100) {
    errors.push('Marks for correct answers must be between 0 and 100.');
  }

  const marksIncorrect = Number(qdata.marksIncorrect);
  if (isNaN(marksIncorrect) || marksIncorrect < -100 || marksIncorrect > 0) {
    errors.push('Negative marks must be between -100 and 0.');
  }

  /** @type {UntrustedInput[]} */
  const subjects = Array.isArray(qdata.subjects) ? qdata.subjects : [];
  if (subjects.length === 0) {
    errors.push('The exam must contain at least one subject.');
  }
  /** @type {Set<string>} */
  const normalizedSubjects = new Set();
  subjects.forEach((subject) => {
    const normalized = String(subject || '').trim();
    const key = normalized.toLocaleLowerCase();
    if (!knownSubjects.includes(key)) {
      errors.push(`Unknown subject "${normalized || '(empty)'}". Add it under Subjects & Patterns first.`);
    }
    if (normalizedSubjects.has(key)) {
      errors.push(`Duplicate subject "${normalized}".`);
    }
    normalizedSubjects.add(key);
  });

  // 2. Questions Validation
  const questionsObj = qdata.questions;
  let totalQuestions = 0;

  if (!questionsObj || typeof questionsObj !== 'object' || Array.isArray(questionsObj)) {
    errors.push('Exam questions structure is missing or invalid.');
  } else {
    Object.keys(questionsObj).forEach((subject) => {
      if (!normalizedSubjects.has(subject.trim().toLocaleLowerCase())) {
        errors.push(`Questions contain undeclared subject "${subject}".`);
      }
    });
    /** @type {Set<string>} */
    const seenQuestionIds = new Set();
    for (const sub of subjects) {
      const subQuestions = questionsObj[sub];
      if (!Array.isArray(subQuestions) || subQuestions.length === 0) {
        errors.push(`Subject "${sub}" is declared in subjects list but contains no questions.`);
        subjectCounts[sub] = 0;
        continue;
      }
      subjectCounts[sub] = subQuestions.length;

      subQuestions.forEach((/** @type {UntrustedInput} */ q, /** @type {number} */ idx) => {
        totalQuestions += 1;
        const qNum = idx + 1;
        if (!q || typeof q !== 'object' || Array.isArray(q)) {
          errors.push(`[${sub} Q${qNum}] Question entry is missing or malformed (expected an object).`);
          return;
        }
        const qId = String(q.id || '').trim();
        const type = String(q.type || 'MCQ').toUpperCase();
        const text = String(q.text || '').trim();
        const questionImg = String(q.questionImageUrl || q.imageUrl || '').trim();
        const hasImageOrDiagram = Boolean(q.hasImageOrDiagram || q.has_image_or_diagram);

        if (!qId) {
          errors.push(`[${sub} Q${qNum}] A stable question ID is required.`);
        } else if (seenQuestionIds.has(qId)) {
          errors.push(`[${sub} Q${qNum}] Duplicate question ID "${qId}".`);
        } else {
          seenQuestionIds.add(qId);
        }

        if (!text && !questionImg) {
          errors.push(`[${sub} Q${qNum}] Question must contain text or a prompt image.`);
        }
        if (text.length > 10000) {
          errors.push(`[${sub} Q${qNum}] Question text exceeds 10,000 characters.`);
        }
        if (hasImageOrDiagram && !questionImg) {
          errors.push(`[${sub} Q${qNum}] Marked as requiring an image or diagram, but no image is attached.`);
        }

        // LaTeX check on prompt text
        const latexCheck = checkLatexDelimiters(text);
        if (!latexCheck.balanced) {
          warnings.push(`[${sub} Q${qNum}] ${latexCheck.reason} in question prompt.`);
        }

        // Inspect prompt image
        if (questionImg) {
          if (questionImg.startsWith('http://')) {
            errors.push(`[${sub} Q${qNum}] Insecure unencrypted HTTP image URL is not permitted: "${questionImg}".`);
            insecureAssets.add(questionImg);
          } else if (questionImg.startsWith('https://') || questionImg.startsWith('data:')) {
            errors.push(`[${sub} Q${qNum}] Images must use a private exam-assets path; external and embedded images are not permitted.`);
            externalAssets.add(questionImg);
          } else {
            storageAssets.add(questionImg);
          }
        }

        // Validate type-specific constraints
        if (type === 'MCQ') {
          const options = Array.isArray(q.options) ? q.options : [];
          if (options.length !== 4) {
            errors.push(`[${sub} Q${qNum}] MCQ question must have exactly 4 options (found ${options.length}).`);
          }

          const optionImages = Array.isArray(q.optionImageUrls) ? q.optionImageUrls : [];
          if (q.optionImageUrls != null && optionImages.length !== 4) {
            errors.push(`[${sub} Q${qNum}] Option image references must contain exactly 4 positions.`);
          }
          options.forEach((/** @type {unknown} */ opt, /** @type {number} */ optIdx) => {
            const optLabel = String.fromCharCode(65 + optIdx);
            const optText = String(opt || '').trim();
            const optImg = String(optionImages[optIdx] || '').trim();

            if (!optText && !optImg) {
              errors.push(`[${sub} Q${qNum}] Option ${optLabel} must contain text or an image.`);
            }
            if (optText.length > 5000) {
              errors.push(`[${sub} Q${qNum}] Option ${optLabel} text exceeds 5,000 characters.`);
            }

            const optLatex = checkLatexDelimiters(optText);
            if (!optLatex.balanced) {
              warnings.push(`[${sub} Q${qNum}] ${optLatex.reason} in Option ${optLabel}.`);
            }

            if (optImg) {
              if (optImg.startsWith('http://')) {
                errors.push(`[${sub} Q${qNum}] Option ${optLabel} uses insecure HTTP image URL: "${optImg}".`);
                insecureAssets.add(optImg);
              } else if (optImg.startsWith('https://') || optImg.startsWith('data:')) {
                errors.push(`[${sub} Q${qNum}] Option ${optLabel} must use a private exam-assets path.`);
                externalAssets.add(optImg);
              } else {
                storageAssets.add(optImg);
              }
            }
          });

          const ans = String(q.correctAnswer ?? q.correct_answer ?? '').trim();
          if (!/^[0-3]$/.test(ans) && !/^[A-D]$/i.test(ans)) {
            errors.push(`[${sub} Q${qNum}] MCQ question has invalid correct answer "${ans}". Must be 0-3 or A-D.`);
          }
        } else if (type === 'NUMERICAL' || type === 'NAT') {
          if (Array.isArray(q.options) && q.options.length > 0) {
            errors.push(`[${sub} Q${qNum}] Numerical question must have an empty options array.`);
          }
          const ans = String(q.correctAnswer ?? q.correct_answer ?? '').trim();
          if (!ans || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(ans) || ans.length > 100) {
            errors.push(`[${sub} Q${qNum}] Numerical question has invalid answer "${ans}". Must be a valid number.`);
          }
        } else {
          errors.push(`[${sub} Q${qNum}] Unsupported question type "${type}".`);
        }
      });
    }
  }

  if (totalQuestions === 0) {
    errors.push('The exam paper must contain at least one question.');
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    stats: {
      totalQuestions,
      subjectCounts,
      storageAssetCount: storageAssets.size,
      externalAssetCount: externalAssets.size
    },
    storageAssets: Array.from(storageAssets)
  };
};
