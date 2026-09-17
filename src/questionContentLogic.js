import { ALLOWED_IMPORT_SUBJECTS, canonicalQuestionText } from './importLogic.js';
import { AUTHOR_NUMERICAL_MAX_LENGTH, isValidNumericalAnswer } from './numericalAnswerPolicy.js';

const fixedArray = (value, length, fallback = null) => Array.from(
  { length },
  (_, index) => Array.isArray(value) ? (value[index] ?? fallback) : fallback
);

export const prepareQuestionDraft = (draft, existingQuestions = []) => {
  const type = String(draft?.type || '').toUpperCase() === 'NAT' ? 'NUMERICAL' : String(draft?.type || '').toUpperCase();
  const text = String(draft?.text ?? draft?.question_text ?? '').trim();
  const subject = String(draft?.subject || '').trim();
  const questionImageUrl = draft?.questionImageUrl || draft?.question_image_url || null;
  const sourceOptionImages = draft?.optionImageUrls || draft?.option_image_urls;
  const optionImageUrls = type === 'NUMERICAL' ? [] : fixedArray(sourceOptionImages, 4);
  const options = type === 'NUMERICAL'
    ? []
    : fixedArray(draft?.options, 4, '').map(option => String(option || '').trim());
  const correctAnswer = String(draft?.correctAnswer ?? draft?.correct_answer ?? '').trim();
  const hasImageOrDiagram = Boolean(draft?.hasImageOrDiagram ?? draft?.has_image_or_diagram) || Boolean(questionImageUrl);
  const errors = [];

  if (!ALLOWED_IMPORT_SUBJECTS.includes(subject)) errors.push('Subject must be Physics, Chemistry, or Mathematics.');
  if (!['MCQ', 'NUMERICAL'].includes(type)) errors.push('Question type must be MCQ or NUMERICAL.');
  if (!text && !questionImageUrl) errors.push('Enter a question prompt or upload a question image.');
  if (text.length > 10000) errors.push('Question text must not exceed 10,000 characters.');
  if (hasImageOrDiagram && !questionImageUrl) errors.push('This question is marked as requiring an image or diagram. Upload it before saving.');

  if (type === 'MCQ') {
    const optionKeys = new Set();
    options.forEach((option, index) => {
      const image = optionImageUrls[index];
      if (!option && !image) errors.push(`Provide text or an image for Option ${String.fromCharCode(65 + index)}.`);
      if (option.length > 5000) errors.push(`Option ${String.fromCharCode(65 + index)} must not exceed 5,000 characters.`);
      const key = image ? `img:${image}` : `text:${canonicalQuestionText(option)}`;
      if ((option || image) && optionKeys.has(key)) errors.push(`Option ${String.fromCharCode(65 + index)} duplicates another option.`);
      optionKeys.add(key);
    });
    if (!/^[0-3]$/.test(correctAnswer)) errors.push('Select a valid correct option from A to D.');
  } else if (type === 'NUMERICAL') {
    if (!isValidNumericalAnswer(correctAnswer, AUTHOR_NUMERICAL_MAX_LENGTH)) {
      errors.push('Enter a valid numerical answer of at most 100 characters.');
    }
  }

  const key = canonicalQuestionText(text);
  if (key && existingQuestions.some(question => {
    if ((question.docId || question.id) === (draft.docId || draft.id)) return false;
    return canonicalQuestionText(question.text ?? question.question_text) === key;
  })) errors.push('A matching question already exists in the Question Bank.');

  return {
    question: {
      ...draft,
      subject,
      type,
      text,
      options,
      correctAnswer,
      questionImageUrl,
      optionImageUrls,
      hasImageOrDiagram
    },
    errors: [...new Set(errors)]
  };
};
