import { useId, useState, useRef } from 'react';
import ReactDOM from 'react-dom';
import { customAlert, customConfirm } from '../utils';
import MathRenderer from './MathRenderer';
import { supabase } from '../supabase';
import StorageImage from './StorageImage';
import { prepareQuestionDraft } from '../questionContentLogic';
import { validateImageUpload } from '../imageValidation';
import { useDialogFocusTrap } from '../dialogFocus';
import { AlertCircle, CheckCircle2, Eye, Hash, ImagePlus, Keyboard, ListChecks, Loader2, PencilLine, Save, Trash2, UploadCloud, X } from 'lucide-react';
import { Badge, Button, Field, Input, Label, Select, Textarea, cn } from './ui';

/** @type {Record<string, string[]>} */
const JEE_SYMBOLS = {
  Math: ['∫', '∑', '√', '±', 'π', '∞', '∈', '∉', '⊂', '∪', '∩', '∠', '∴', '∵', '≈', '≠', '≤', '≥', '½', '¼', 'x²', 'x³'],
  Physics: ['α', 'β', 'γ', 'θ', 'λ', 'μ', 'ω', 'Ω', 'Δ', 'Φ', 'ε', 'ρ', 'τ', '°', 'ħ', '→', '↑', '↓'],
  Chemistry: ['⇌', '⇄', '↑', '↓', '°C', '∆H', '∆S', '∆G', 'E°']
};

/**
 * @typedef {object} EditorQuestion
 * @property {string} [id]
 * @property {string} [docId]
 * @property {string} [subject]
 * @property {string} [type]
 * @property {string} [text]
 * @property {string[]} options
 * @property {Array<string | null>} optionImageUrls
 * @property {string | null} [questionImageUrl]
 * @property {string | number | null} [correctAnswer]
 */

/**
 * @typedef {object} QuestionEditorProps
 * @property {Omit<Partial<EditorQuestion>, 'options' | 'optionImageUrls'> & { options?: string[] | null, optionImageUrls?: Array<string | null> | null }} question
 * @property {(question: import('../types').PreparedQuestion) => Promise<boolean | void> | boolean | void} onSave
 * @property {() => void} onCancel
 * @property {import('../types').QuestionTextLike[]} [existingQuestions]
 * @property {string[]} [subjects]
 */

/** @typedef {'text' | number} EditorField */
/** @typedef {'question' | number} ImageField */

const IMAGE_ACCEPT = 'image/jpeg,image/png,image/webp';

/**
 * Drop target for one image slot, with a real button as the keyboard / pointer
 * fallback. Files from either path go to `onFile`, which runs the same
 * validate -> re-encode -> private-bucket upload flow.
 * @param {{
 *   inputId: string,
 *   label: string,
 *   buttonLabel: string,
 *   onFile: (file: File) => void,
 *   onDropError: (message: string) => void,
 *   disabled: boolean,
 *   busy: boolean,
 *   error?: string,
 *   compact?: boolean,
 *   children?: import('react').ReactNode
 * }} props
 */
function ImageDropZone({ inputId, label, buttonLabel, onFile, onDropError, disabled, busy, error, compact = false, children }) {
  const inputRef = useRef(/** @type {HTMLInputElement | null} */ (null));
  const [dragActive, setDragActive] = useState(false);
  const hintId = `${inputId}-hint`;
  const errorId = `${inputId}-error`;

  /** @param {import('react').DragEvent<HTMLDivElement>} event */
  const allowDrop = (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (event.dataTransfer) event.dataTransfer.dropEffect = disabled ? 'none' : 'copy';
    if (!disabled) setDragActive(true);
  };

  /** @param {import('react').DragEvent<HTMLDivElement>} event */
  const handleDragLeave = (event) => {
    // Ignore leave events fired when moving between the zone's own children.
    if (event.currentTarget.contains(/** @type {Node | null} */ (event.relatedTarget))) return;
    setDragActive(false);
  };

  /** @param {import('react').DragEvent<HTMLDivElement>} event */
  const handleDrop = (event) => {
    event.preventDefault();
    event.stopPropagation();
    setDragActive(false);
    if (disabled) return;
    const files = Array.from(event.dataTransfer?.files || []);
    if (files.length === 0) {
      onDropError('Drop an image file (JPEG, PNG, or WebP).');
      return;
    }
    if (files.length > 1) {
      onDropError('Drop one image at a time.');
      return;
    }
    onFile(files[0]);
  };

  return (
    <div
      role="group"
      aria-label={label}
      aria-busy={busy || undefined}
      data-drag-active={dragActive || undefined}
      onDragEnter={allowDrop}
      onDragOver={allowDrop}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      className={cn(
        'flex flex-wrap items-center gap-2 rounded-lg border-2 border-dashed transition-colors',
        compact ? 'px-2.5 py-2' : 'px-3 py-3',
        dragActive ? 'border-brand-500 bg-brand-50' : error ? 'border-red-300 bg-red-50/40' : 'border-slate-300 bg-white',
        disabled && !busy && 'opacity-70'
      )}
    >
      <input
        ref={inputRef}
        type="file"
        id={inputId}
        accept={IMAGE_ACCEPT}
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = '';
          if (file) onFile(file);
        }}
        className="hidden"
        disabled={disabled}
        tabIndex={-1}
      />
      <Button
        variant="secondary"
        size="sm"
        className={compact ? 'h-7 px-2.5' : undefined}
        disabled={disabled}
        aria-describedby={cn(hintId, error && errorId)}
        onClick={() => inputRef.current?.click()}
      >
        {busy ? <Loader2 className="animate-spin" aria-hidden="true" /> : <ImagePlus aria-hidden="true" />}
        {busy ? 'Uploading...' : buttonLabel}
      </Button>
      <span id={hintId} className="inline-flex items-center gap-1.5 text-xs text-slate-500">
        <UploadCloud className="size-3.5 shrink-0" aria-hidden="true" />
        {dragActive ? 'Release to upload' : compact ? 'or drop an image here' : 'or drag and drop a JPEG, PNG, or WebP image (max 5 MB)'}
      </span>
      {children}
      {error && (
        <p id={errorId} role="alert" className="flex w-full items-start gap-1.5 text-xs font-medium text-red-700">
          <AlertCircle className="mt-px size-3.5 shrink-0" aria-hidden="true" />
          {error}
        </p>
      )}
    </div>
  );
}

/**
 * Read-only rendering of the draft the way candidates see it in the exam
 * (prompt with math, images, lettered options / numerical input). The correct
 * answer is marked for the author only.
 * @param {{ question: EditorQuestion, headingId: string }} props
 */
function QuestionPreview({ question, headingId }) {
  const isNumerical = question.type === 'NUMERICAL';
  const options = question.options || [];
  const correctIndex = Number(question.correctAnswer);
  const hasNumericalAnswer = question.correctAnswer !== '' && question.correctAnswer !== null && question.correctAnswer !== undefined;
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id={headingId} className="flex items-center gap-2 text-sm font-semibold text-slate-900">
          <Eye className="size-4 text-brand-600" aria-hidden="true" />
          Student view preview
        </h3>
        <span className="text-xs text-slate-500">Updates as you type</span>
      </div>
      <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
        <div className="flex flex-wrap items-center gap-2 border-b border-slate-200 px-4 py-3">
          <span className="text-sm font-semibold text-slate-900">Question</span>
          <Badge variant={isNumerical ? 'warning' : 'brand'} className="uppercase tracking-wide">
            {isNumerical ? <Hash aria-hidden="true" /> : <ListChecks aria-hidden="true" />}
            {isNumerical ? 'NUMERICAL VALUE TYPE' : 'MULTIPLE CHOICE'}
          </Badge>
          {question.subject && <Badge variant="neutral">{question.subject}</Badge>}
        </div>
        <div className="flex flex-col gap-4 px-4 py-4">
          {question.text?.trim() ? (
            <p className="whitespace-pre-wrap text-base leading-relaxed text-slate-900"><MathRenderer text={question.text} /></p>
          ) : (
            <p className="text-sm italic text-slate-400">The question prompt will appear here.</p>
          )}
          {question.questionImageUrl && (
            <StorageImage src={question.questionImageUrl} alt="Question context" className="max-h-[320px] max-w-full self-start rounded-lg border border-slate-200 shadow-sm" />
          )}
          {isNumerical ? (
            <div className="flex max-w-sm flex-col gap-2">
              <span className="text-sm font-semibold text-slate-800">Your Numerical Answer:</span>
              <div aria-hidden="true" className="flex h-12 items-center rounded-lg border-2 border-brand-500 px-3 text-slate-400">Enter numerical value...</div>
              <p className="text-xs text-slate-600">
                Answer key: <span className="font-semibold tabular-nums text-slate-900">{hasNumericalAnswer ? String(question.correctAnswer) : 'not set'}</span>
              </p>
            </div>
          ) : (
            <ol aria-label="Answer options" className="flex flex-col gap-2.5">
              {options.map((option, idx) => {
                const letter = String.fromCharCode(65 + idx);
                const isCorrect = correctIndex === idx;
                return (
                  <li
                    key={idx}
                    className={cn(
                      'flex min-h-12 items-start gap-3 rounded-xl border-2 px-4 py-3',
                      isCorrect ? 'border-emerald-400 bg-emerald-50/60' : 'border-slate-200 bg-white'
                    )}
                  >
                    <strong className={cn(
                      'inline-flex h-7 min-w-8 shrink-0 items-center justify-center rounded-full px-2 text-sm font-semibold',
                      isCorrect ? 'bg-emerald-600 text-white' : 'bg-slate-100 text-slate-700'
                    )}>
                      {letter}.
                    </strong>
                    <div className="flex min-w-0 flex-1 flex-col gap-2 pt-0.5">
                      {option?.trim() ? (
                        <span className="whitespace-pre-wrap text-base text-slate-800"><MathRenderer text={option} /></span>
                      ) : !question.optionImageUrls?.[idx] ? (
                        <span className="text-sm italic text-slate-400">Option {letter} is empty</span>
                      ) : null}
                      {question.optionImageUrls?.[idx] && (
                        <StorageImage src={question.optionImageUrls[idx]} alt={`Option ${letter}`} className="max-h-[160px] max-w-full self-start rounded-md border border-slate-200" />
                      )}
                    </div>
                    {isCorrect && (
                      <Badge variant="success" className="shrink-0">
                        <CheckCircle2 aria-hidden="true" />
                        Correct
                      </Badge>
                    )}
                  </li>
                );
              })}
            </ol>
          )}
        </div>
      </div>
      <p className="text-xs text-slate-500">The correct answer is highlighted for your review only; candidates do not see it.</p>
    </section>
  );
}

/** @param {QuestionEditorProps} props */
const QuestionEditor = ({ question, onSave, onCancel, existingQuestions, subjects = [] }) => {
  // Configured active subjects. A question already filed under a subject that was
  // later deactivated keeps it as an option so it can still be edited.
  const originalSubject = String(question?.subject || '').trim();
  const subjectOptions = originalSubject && !subjects.some(name => name.toLowerCase() === originalSubject.toLowerCase())
    ? [...subjects, originalSubject]
    : subjects;
  const [editedQ, setEditedQ] = useState(/** @type {EditorQuestion} */ ({
    ...question,
    options: question.options || ['', '', '', ''],
    optionImageUrls: question.optionImageUrls || [null, null, null, null],
  }));
  
  const [focusedField, setFocusedField] = useState(/** @type {EditorField} */ ('text')); // 'text' or 0,1,2,3
  const [uploading, setUploading] = useState(false);
  const [uploadingField, setUploadingField] = useState(/** @type {ImageField | null} */ (null));
  const [imageErrors, setImageErrors] = useState(/** @type {Partial<Record<ImageField, string>>} */ ({}));
  const [activeCategory, setActiveCategory] = useState('All');
  const fieldId = useId();
  const uploadedPathsRef = useRef(/** @type {string[]} */ ([]));
  
  const textRef = useRef(/** @type {HTMLTextAreaElement | null} */ (null));
  const opt0Ref = useRef(/** @type {HTMLTextAreaElement | null} */ (null));
  const opt1Ref = useRef(/** @type {HTMLTextAreaElement | null} */ (null));
  const opt2Ref = useRef(/** @type {HTMLTextAreaElement | null} */ (null));
  const opt3Ref = useRef(/** @type {HTMLTextAreaElement | null} */ (null));

  /** @type {Record<EditorField, import('react').RefObject<HTMLTextAreaElement | null>>} */
  const textRefs = {
    'text': textRef,
    0: opt0Ref,
    1: opt1Ref,
    2: opt2Ref,
    3: opt3Ref
  };

  const getSymbolsToDisplay = () => {
    if (activeCategory === 'All') {
      const allSyms = Object.values(JEE_SYMBOLS).flat();
      return Array.from(new Set(allSyms));
    }
    return JEE_SYMBOLS[activeCategory];
  };

  /**
   * @param {EditorField} field
   * @param {string} value
   */
  const handleTextChange = (field, value) => {
    if (field === 'text') {
      setEditedQ({ ...editedQ, text: value });
    } else {
      const newOptions = [...editedQ.options];
      newOptions[field] = value;
      setEditedQ({ ...editedQ, options: newOptions });
    }
  };

  /** @param {string} symbol */
  const insertSymbol = (symbol) => {
    const textarea = textRefs[focusedField].current;
    if (!textarea) return;

    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const currentValue = /** @type {string} */ (focusedField === 'text' ? editedQ.text : editedQ.options[focusedField]);
    
    const newValue = currentValue.substring(0, start) + symbol + currentValue.substring(end);
    
    handleTextChange(focusedField, newValue);
    
    // Set cursor position after inserted symbol (needs a slight timeout to let React render)
    setTimeout(() => {
      textarea.selectionStart = textarea.selectionEnd = start + symbol.length;
      textarea.focus();
    }, 0);
  };

  /**
   * @param {ImageField} field
   * @param {string} message
   */
  const reportImageError = (field, message) => {
    setImageErrors(prev => ({ ...prev, [field]: message }));
  };

  /** @param {ImageField} field */
  const finishUpload = (field) => {
    setUploading(false);
    setUploadingField(current => (current === field ? null : current));
  };

  /**
   * Shared by the file picker and drag-and-drop: validate the file (type, size,
   * signature, dimensions), re-encode it as a bounded JPEG and upload it to the
   * private exam-assets bucket. Errors are shown next to the image slot.
   * @param {File} file
   * @param {ImageField} field
   */
  const handleImageUpload = async (file, field) => {
    if (!file || uploading) return;
    setImageErrors(prev => ({ ...prev, [field]: '' }));

    const validation = await validateImageUpload(file);
    if (!validation.valid) {
      reportImageError(field, /** @type {string} */ (validation.error));
      return;
    }

    setUploading(true);
    setUploadingField(field);
    try {
      const reader = new FileReader();
      reader.onload = (event) => {
        const img = new Image();
        img.onload = () => {
          if (!img.width || !img.height || img.width > 12000 || img.height > 12000 || img.width * img.height > 40000000) {
            finishUpload(field);
            reportImageError(field, 'The image dimensions are too large to process safely. Use an image under 40 megapixels.');
            return;
          }
          const canvas = document.createElement('canvas');
          const MAX_DIMENSION = 800;
          let width = img.width;
          let height = img.height;

          if (Math.max(width, height) > MAX_DIMENSION) {
            const scale = MAX_DIMENSION / Math.max(width, height);
            width = Math.round(width * scale);
            height = Math.round(height * scale);
          }
          canvas.width = width;
          canvas.height = height;

          const ctx = canvas.getContext('2d');
          if (!ctx) {
            finishUpload(field);
            reportImageError(field, 'This browser could not process the image. Try another supported image.');
            return;
          }
          ctx.drawImage(img, 0, 0, width, height);

          // Store compressed files in Supabase Storage. Keeping base64 image
          // payloads inside question_bank makes every database row needlessly
          // large and quickly consumes the database quota.
          canvas.toBlob(async (blob) => {
            try {
              if (!blob) throw new Error('Image compression failed');
              const path = `questions/${crypto.randomUUID()}.jpg`;
              const { error: uploadError } = await supabase.storage
                .from('exam-assets')
                .upload(path, blob, { contentType: 'image/jpeg', upsert: false });
              if (uploadError) throw uploadError;
              uploadedPathsRef.current.push(path);

              if (field === 'question') {
                setEditedQ(prev => ({ ...prev, questionImageUrl: path }));
              } else {
                setEditedQ(prev => {
                  const newOptionImages = [...prev.optionImageUrls];
                  newOptionImages[field] = path;
                  return { ...prev, optionImageUrls: newOptionImages };
                });
              }
            } catch (err) {
              console.error('Image upload failed', err);
              reportImageError(field, 'Image upload failed. Please try again.');
            } finally {
              finishUpload(field);
            }
          }, 'image/jpeg', 0.7);
        };
        img.onerror = () => {
          finishUpload(field);
          reportImageError(field, 'The selected file is not a readable image.');
        };
        img.src = /** @type {string} */ (/** @type {FileReader} */ (event.target).result);
      };
      reader.onerror = () => {
        finishUpload(field);
        reportImageError(field, 'The selected image could not be read.');
      };
      reader.readAsDataURL(file);
    } catch (err) {
      console.error("Image processing failed", err);
      reportImageError(field, 'Failed to process image.');
      finishUpload(field);
    }
  };

  const validateAndSave = async () => {
    const { question: normalizedQuestion, errors } = prepareQuestionDraft(editedQ, existingQuestions, { allowedSubjects: subjectOptions });
    if (errors.length > 0) {
      await customAlert(errors.join('\n'));
      return;
    }

    const referencedPaths = new Set([
      normalizedQuestion.questionImageUrl,
      ...(normalizedQuestion.optionImageUrls || [])
    ].filter(Boolean));
    /** @type {string[]} */
    const unusedUploads = uploadedPathsRef.current.filter(path => !referencedPaths.has(path));
    if (unusedUploads.length > 0) {
      await supabase.storage.from('exam-assets').remove(unusedUploads);
      uploadedPathsRef.current = uploadedPathsRef.current.filter(path => referencedPaths.has(path));
    }

    const saved = await onSave(normalizedQuestion);
    if (saved !== false) uploadedPathsRef.current = [];
  };

  const cancelEditor = async () => {
    const hasChanges = editedQ.text !== (question.text || '') ||
      JSON.stringify(editedQ.options) !== JSON.stringify(question.options || ['', '', '', '']) ||
      editedQ.questionImageUrl !== (question.questionImageUrl || null);
    
    if (hasChanges) {
      const confirmed = await customConfirm('Discard unsaved changes to this question?');
      if (!confirmed) return;
    }

    if (uploadedPathsRef.current.length > 0) {
      await supabase.storage.from('exam-assets').remove(uploadedPathsRef.current);
      uploadedPathsRef.current = [];
    }
    onCancel();
  };

  const { dialogRef, handleDialogKeyDown } = useDialogFocusTrap({
    onEscape: cancelEditor,
    initialFocusRef: textRef
  });

  const modalContent = (
    <div
      ref={/** @type {import('react').RefObject<HTMLDivElement>} */ (dialogRef)}
      role="dialog"
      aria-modal="true"
      aria-labelledby="question-editor-title"
      tabIndex={-1}
      onKeyDown={handleDialogKeyDown}
      // A file dropped outside an image slot must not make the browser navigate away.
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => e.preventDefault()}
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-slate-900/60 p-4 backdrop-blur-[2px]"
    >
      <div className="animate-fade-in flex max-h-[92vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-elevated lg:max-w-6xl 2xl:max-w-7xl">
        <div className="flex items-center justify-between gap-3 border-b border-slate-100 px-6 py-4">
          <h2 id="question-editor-title" className="flex items-center gap-2 text-lg font-semibold tracking-tight text-slate-900">
            <PencilLine className="size-5 text-slate-500" aria-hidden="true" />
            Edit Question
          </h2>
          <Button variant="ghost" size="icon" onClick={cancelEditor} aria-label="Close question editor">
            <X aria-hidden="true" />
          </Button>
        </div>

        {/* Wide screens: editor left, live student-view preview right, each scrolling on its own.
            Narrow screens: one scrolling column with the preview after the editor. */}
        <div className="min-h-0 flex-1 overflow-y-auto lg:grid lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)] lg:overflow-hidden">
        <div className="space-y-6 px-6 py-5 lg:overflow-y-auto">
          {/* Math Keyboard */}
          <section aria-label="Symbol keyboard" className="rounded-xl border border-slate-200 bg-slate-50 p-4">
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <Keyboard className="mr-1 size-4 text-slate-400" aria-hidden="true" />
              {['All', ...Object.keys(JEE_SYMBOLS)].map(cat => (
                <button
                  key={cat}
                  type="button"
                  onClick={() => setActiveCategory(cat)}
                  aria-pressed={activeCategory === cat}
                  className={cn(
                    'inline-flex h-7 items-center rounded-full border px-3 text-xs font-semibold transition-colors',
                    activeCategory === cat
                      ? 'border-brand-600 bg-brand-600 text-white'
                      : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-100'
                  )}
                >
                  {cat}
                </button>
              ))}
            </div>
            <div className="flex flex-wrap gap-1.5">
              {getSymbolsToDisplay().map((sym, idx) => (
                <button
                  key={`${sym}-${idx}`}
                  type="button"
                  onClick={() => insertSymbol(sym)}
                  title={`Insert ${sym}`}
                  className="grid h-9 min-w-9 place-items-center rounded-md border border-slate-200 bg-white px-1.5 text-base text-slate-800 shadow-sm transition-colors hover:border-brand-300 hover:bg-brand-50"
                >
                  {sym}
                </button>
              ))}
            </div>
            <p className="mt-2 text-xs text-slate-500">
              Click a symbol to insert it into the currently active text box.
            </p>
          </section>

          {/* Type & Subject Selection */}
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Question Type" htmlFor={`${fieldId}-type`}>
              <Select
                id={`${fieldId}-type`}
                value={editedQ.type || 'MCQ'}
                onChange={(e) => {
                  const newType = e.target.value;
                  setEditedQ({
                    ...editedQ,
                    type: newType,
                    correctAnswer: newType === 'NUMERICAL' ? '' : 0,
                    options: newType === 'NUMERICAL' ? [] : ['', '', '', ''],
                    optionImageUrls: newType === 'NUMERICAL' ? [] : [null, null, null, null]
                  });
                }}
              >
                <option value="MCQ">Multiple Choice Question (MCQ)</option>
                <option value="NUMERICAL">Numerical Answer Type (NAT)</option>
              </Select>
            </Field>
            <Field label="Subject" htmlFor={`${fieldId}-subject`}>
              <Select
                id={`${fieldId}-subject`}
                value={editedQ.subject || ''}
                onChange={(e) => setEditedQ({ ...editedQ, subject: e.target.value })}
              >
                {!editedQ.subject && <option value="">Choose a subject…</option>}
                {subjectOptions.map(name => (
                  <option key={name} value={name}>
                    {name}{name === originalSubject && !subjects.includes(name) ? ' (inactive)' : ''}
                  </option>
                ))}
              </Select>
            </Field>
          </div>

          {/* Question Text & Image */}
          <Field label="Question Prompt" htmlFor={`${fieldId}-text`}>
            <Textarea
              id={`${fieldId}-text`}
              ref={textRefs['text']}
              value={editedQ.text}
              onChange={(e) => handleTextChange('text', e.target.value)}
              onFocus={() => setFocusedField('text')}
              className="min-h-24 resize-y"
            />
            {editedQ.text && (
              <div className="rounded-lg border border-brand-100 bg-brand-50/50 px-3 py-2 text-sm text-slate-800 lg:hidden">
                <span className="mb-1 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-brand-700">
                  <Eye className="size-3.5" aria-hidden="true" />
                  Live math preview
                </span>
                <MathRenderer text={editedQ.text} />
              </div>
            )}
            <div className="mt-1">
              <ImageDropZone
                inputId="q-img-upload"
                label="Question image"
                buttonLabel="Upload Question Image"
                onFile={(file) => handleImageUpload(file, 'question')}
                onDropError={(message) => reportImageError('question', message)}
                disabled={uploading}
                busy={uploadingField === 'question'}
                error={imageErrors.question}
              >
                {editedQ.questionImageUrl && (
                  <div className="flex items-center gap-2 rounded-lg border border-slate-200 bg-white p-1 pr-2">
                    <StorageImage src={editedQ.questionImageUrl} alt="Question" className="h-10 rounded-md border border-slate-200" />
                    <Button variant="ghost" size="sm" className="text-red-600 hover:bg-red-50 hover:text-red-700" onClick={() => setEditedQ({...editedQ, questionImageUrl: null})}>
                      <Trash2 aria-hidden="true" />
                      Remove
                    </Button>
                  </div>
                )}
              </ImageDropZone>
            </div>
          </Field>

          {/* Options / Numerical Answer */}
          {editedQ.type === 'NUMERICAL' ? (
            <div className="rounded-xl border border-amber-200 bg-amber-50/60 p-5">
              <h4 className="mb-1 flex items-center gap-2 text-sm font-semibold text-amber-900">
                <Hash className="size-4 text-amber-600" aria-hidden="true" />
                Numerical Answer Type (NAT)
              </h4>
              <p className="mb-4 text-sm text-slate-600">
                This question does not have multiple choice options. The student will enter a numerical value directly into an input box or keypad.
              </p>
              <Field label="Exact Correct Answer (Integer or Decimal):" htmlFor={`${fieldId}-numerical`}>
                <Input
                  id={`${fieldId}-numerical`}
                  type="number"
                  step="any"
                  placeholder="e.g. 250, 9.8, -3.14"
                  value={editedQ.correctAnswer !== null && editedQ.correctAnswer !== undefined ? editedQ.correctAnswer : ''}
                  onChange={(e) => setEditedQ({ ...editedQ, correctAnswer: e.target.value === '' ? '' : Number(e.target.value) })}
                  className="h-11 max-w-xs text-base font-semibold tabular-nums"
                />
              </Field>
            </div>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2">
              {[0, 1, 2, 3].map(i => {
                const letter = String.fromCharCode(65 + i);
                const isCorrect = Number(editedQ.correctAnswer) === i;
                return (
                  <div
                    key={i}
                    className={cn(
                      'flex flex-col gap-2 rounded-xl border p-4 transition-colors',
                      isCorrect ? 'border-emerald-300 bg-emerald-50/50' : 'border-slate-200 bg-slate-50/60'
                    )}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <label htmlFor={`${fieldId}-opt-${i}`} className="flex items-center gap-2 text-sm font-medium text-slate-700">
                        <span className={cn('grid size-6 place-items-center rounded-full text-xs font-bold', isCorrect ? 'bg-emerald-600 text-white' : 'bg-white text-slate-600 ring-1 ring-slate-200')}>
                          {letter}
                        </span>
                        Option {letter}
                      </label>
                      {isCorrect && (
                        <Badge variant="success">
                          <CheckCircle2 aria-hidden="true" />
                          Correct
                        </Badge>
                      )}
                    </div>
                    <Textarea
                      id={`${fieldId}-opt-${i}`}
                      ref={textRefs[i]}
                      value={editedQ.options[i]}
                      onChange={(e) => handleTextChange(i, e.target.value)}
                      onFocus={() => setFocusedField(i)}
                      className="min-h-14 resize-y"
                    />
                    {editedQ.options[i] && (
                      <div className="rounded-md border border-brand-100 bg-white px-2.5 py-1.5 text-sm text-slate-800 lg:hidden">
                        <MathRenderer text={editedQ.options[i]} />
                      </div>
                    )}
                    <ImageDropZone
                      inputId={`opt-img-${i}`}
                      label={`Option ${letter} image`}
                      buttonLabel="Add Image"
                      onFile={(file) => handleImageUpload(file, i)}
                      onDropError={(message) => reportImageError(i, message)}
                      disabled={uploading}
                      busy={uploadingField === i}
                      error={imageErrors[i]}
                      compact
                    >
                      {editedQ.optionImageUrls[i] && (
                        <div className="flex items-center gap-1 rounded-md border border-slate-200 bg-white p-1">
                          <StorageImage src={editedQ.optionImageUrls[i]} alt={`Option ${i}`} className="h-8 rounded" />
                          <Button
                            variant="ghost"
                            size="icon"
                            className="size-7 text-red-600 hover:bg-red-50 hover:text-red-700"
                            aria-label={`Remove image from option ${letter}`}
                            onClick={() => {
                              const newArr = [...editedQ.optionImageUrls];
                              newArr[i] = null;
                              setEditedQ({...editedQ, optionImageUrls: newArr});
                            }}
                          >
                            <X aria-hidden="true" />
                          </Button>
                        </div>
                      )}
                    </ImageDropZone>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="border-t border-slate-100 bg-slate-50/70 px-6 py-5 lg:overflow-y-auto lg:border-l lg:border-t-0">
          <QuestionPreview question={editedQ} headingId={`${fieldId}-preview-title`} />
        </div>
        </div>

        {/* Correct Answer & Save */}
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 bg-slate-50/60 px-6 py-4">
          <div>
            {editedQ.type !== 'NUMERICAL' && (
              <div className="flex items-center gap-3">
                <Label htmlFor={`${fieldId}-correct`} className="whitespace-nowrap">Correct Answer:</Label>
                <Select
                  id={`${fieldId}-correct`}
                  value={/** @type {string | number} */ (editedQ.correctAnswer)}
                  onChange={(e) => setEditedQ({...editedQ, correctAnswer: parseInt(e.target.value)})}
                  className="w-36"
                >
                  {[0, 1, 2, 3].map(i => (
                    <option key={i} value={i}>Option {String.fromCharCode(65 + i)}</option>
                  ))}
                </Select>
              </div>
            )}
          </div>
          <div className="flex gap-2">
            <Button variant="secondary" onClick={cancelEditor}>Cancel</Button>
            <Button onClick={validateAndSave} disabled={uploading}>
              <Save aria-hidden="true" />
              Save Changes
            </Button>
          </div>
        </div>
      </div>
    </div>
  );

  return ReactDOM.createPortal(modalContent, document.body);
};

export default QuestionEditor;
