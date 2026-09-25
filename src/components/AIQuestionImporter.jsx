import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { supabase } from '../supabase';
import MathRenderer from './MathRenderer';
import { customAlert, customConfirm } from '../utils';
import AccessibleModal from './AccessibleModal';
import {
  AlertTriangle,
  Bot,
  Check,
  CheckCircle2,
  Circle,
  Copy,
  DatabaseZap,
  Download,
  ExternalLink,
  Eye,
  EyeOff,
  FileJson,
  FileUp,
  Filter,
  Globe,
  Hash,
  History,
  Image as ImageIcon,
  Inbox,
  ListChecks,
  Loader2,
  RefreshCw,
  Sparkles,
  Trash2,
  UploadCloud
} from 'lucide-react';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Checkbox,
  EmptyState,
  Field,
  Input,
  LoadingBlock,
  Select,
  Table,
  TBody,
  TD,
  TH,
  THead,
  TR,
  Textarea,
  cn
} from './ui';
import {
  MAX_IMPORT_QUESTIONS,
  buildAtomicImportPayload,
  parseImportJsonText,
  resolveAllowedSubjects,
  validateImportQuestions as validateImportRowsForSubjects,
  validateImportConfirmation,
  validateImportFile,
  exportFailedImportRows
} from '../importLogic';

const IMPORT_REQUEST_TIMEOUT_MS = 120000;

const IMPORT_STEPS = ['Prepare JSON', 'Upload & validate', 'Review & approve', 'Import'];

const EXTERNAL_ASSISTANTS = [
  { name: 'ChatGPT', href: 'https://chatgpt.com', title: 'Open ChatGPT in a new tab' },
  { name: 'Gemini', href: 'https://gemini.google.com', title: 'Open Google Gemini in a new tab' },
  { name: 'Claude', href: 'https://claude.ai', title: 'Open Anthropic Claude in a new tab' },
  { name: 'DeepSeek', href: 'https://chat.deepseek.com', title: 'Open DeepSeek in a new tab' }
];

const AI_CONVERSION_PROMPT_TEMPLATE = `You are an expert examination digitizer. Please convert all questions in the attached document/PDF/image into a clean, valid JSON file formatted exactly for our Computer-Based Test (CBT) portal.

FILE GENERATION & DOWNLOAD INSTRUCTIONS:
1. CREATE A DOWNLOADABLE FILE:
   - Use Python/code execution to write the generated JSON directly to a file named 'questions_import.json' and provide a direct, clickable download link so the user can download the file in one click.
   - If using an environment with artifacts (like Claude or ChatGPT Canvas), create it as a standalone downloadable JSON artifact/file.
2. RAW JSON BLOCK:
   - In addition to the downloadable file, output the complete, valid JSON inside a single \`\`\`json code block.
   - Do NOT include markdown commentary or explanations before or after.

JSON STRUCTURE & SCHEMA:
{
  "version": "1.0",
  "questions": [
    {
      "id": "phy-001",
      "question_number": 1,
      "question_text": "In the circuit shown in the figure, find the current through the $5\\\\,\\\\Omega$ resistor.",
      "question_type": "MCQ",
      "options": [
        { "label": "A", "text": "$1\\\\text{ A}$" },
        { "label": "B", "text": "$2\\\\text{ A}$" },
        { "label": "C", "text": "$0.5\\\\text{ A}$" },
        { "label": "D", "text": "$4\\\\text{ A}$" }
      ],
      "correct_answer": "B",
      "subject": "Physics",
      "has_image_or_diagram": true
    },
    {
      "id": "math-002",
      "question_number": 2,
      "question_text": "Let $a_1, a_2, a_3, \\\\ldots$ be a G.P. of positive terms. If $a_1 a_5 = 28$ and $a_2 + a_4 = 29$, then find $a_6$.",
      "question_type": "NUMERICAL",
      "options": [],
      "correct_answer": "112",
      "subject": "Mathematics",
      "has_image_or_diagram": false
    }
  ]
}

STRICT CONVERSION RULES:
1. question_number: Sequential positive integer (1, 2, 3...) preserving original line-wise question order.
2. question_text: Complete question text.
   - All mathematical symbols, formulas, equations, superscripts, subscripts, and scientific units MUST be rendered in KaTeX/LaTeX syntax wrapped in $...$ (for inline) or $$...$$ (for display equations).
   - In JSON strings, ALWAYS double-escape all backslashes (e.g. \\\\frac{a}{b}, \\\\sqrt{x}, \\\\theta, \\\\Delta, \\\\times, \\\\pm, \\\\rightarrow, \\\\text{...}).
   - Ensure all math delimiters ($ or $$) are strictly balanced with opening and closing pairs.
3. question_type: Exactly "MCQ" or "NUMERICAL".
4. options:
   - For "MCQ": Exactly 4 options labeled "A", "B", "C", and "D" with their corresponding text. Use LaTeX $...$ for mathematical expressions inside options.
   - For "NUMERICAL": Empty array [].
5. correct_answer:
   - For "MCQ": The correct option letter ("A", "B", "C", or "D").
   - For "NUMERICAL": The numeric answer as a clean decimal string (e.g. "42", "-2.5", "0"). If unknown from the source paper, provide the solved answer or "0".
6. subject: __SUBJECT_RULE__
7. AUTOMATIC IMAGE & DIAGRAM DETECTION ("has_image_or_diagram"):
   - You MUST automatically check every question in the source paper for diagrams or images and set this flag accurately. Do NOT require the user to check it manually!
   - Set "has_image_or_diagram": true if the question contains OR references ANY visual element, including:
     * Diagrams, figures, schematics, circuits, electrical setups, or pulleys/mechanics drawings.
     * Ray optics diagrams, lenses/mirrors, or magnetic/electric field illustrations.
     * Geometry shapes (triangles, circles, 3D solids, graphs of functions).
     * Graphs, coordinate plots, curves, $P-V$ diagrams, $v-t$ graphs, or charts.
     * Chemical structures, organic benzene/ring structures, skeletal formulas, stereochemistry, or reaction mechanisms with structural drawings.
     * Any question text with "shown in the figure", "in the given diagram", "refer to the graph below", "for the given reaction", etc.
   - Set "has_image_or_diagram": false ONLY when the question and all its options are 100% self-contained text and mathematical equations without any visual figure, drawing, or diagram.
8. id: A unique short alphanumeric identifier (e.g. "phy-001", "chem-002", "math-003").`;

/**
 * @typedef {import('../types').ValidatedImportQuestion & { question_number?: number }} ReviewQuestion Legacy `question_number` is only a display fallback.
 * @typedef {object} ImportHistoryRow
 * @property {string} id
 * @property {string} file_name
 * @property {string} imported_at
 * @property {number} total_questions
 * @property {number} successful_imports
 * @property {number} rejected_questions
 * @property {string} status
 * @typedef {'neutral' | 'success' | 'warning'} PillTone
 */

/** @param {readonly string[]} subjects */
const buildConversionPrompt = subjects => {
  const quoted = subjects.map(subject => `"${subject}"`);
  const list = quoted.length === 1 ? quoted[0]
    : quoted.length === 2 ? `${quoted[0]} or ${quoted[1]}`
      : `${quoted.slice(0, -1).join(', ')}, or ${quoted[quoted.length - 1]}`;
  return AI_CONVERSION_PROMPT_TEMPLATE.replace('__SUBJECT_RULE__', `Exactly one of: ${list}.`);
};

/**
 * @typedef {object} ReviewedJsonImporterProps
 * @property {import('../types').QuestionTextLike[]} questionBank
 * @property {() => Promise<unknown>} refreshQuestionBank
 * @property {unknown} [allowedSubjects] Configured subject names; defaults apply until they load.
 */

/** @param {ReviewedJsonImporterProps} props */
const ReviewedJsonImporter = ({ questionBank, refreshQuestionBank, allowedSubjects }) => {
  // F1: subjects come from Subjects & Patterns; the defaults apply until they load.
  const subjectList = useMemo(() => resolveAllowedSubjects(allowedSubjects), [allowedSubjects]);
  const conversionPrompt = useMemo(() => buildConversionPrompt(subjectList), [subjectList]);
  const validateImportQuestions = useCallback(
    (/** @type {import('../types').UntrustedInput[]} */ rows, /** @type {import('../types').QuestionTextLike[]} */ bank) => validateImportRowsForSubjects(rows, bank, { allowedSubjects: subjectList }),
    [subjectList]
  );
  const [dragActive, setDragActive] = useState(false);
  const [hasParsedData, setHasParsedData] = useState(false);
  const [questions, setQuestions] = useState(/** @type {ReviewQuestion[]} */ ([]));
  const [filterTab, setFilterTab] = useState('ALL'); // 'ALL' | 'VALID' | 'FAILED'
  const [importHistory, setImportHistory] = useState(/** @type {ImportHistoryRow[]} */ ([]));
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [historyError, setHistoryError] = useState('');
  const [copiedPrompt, setCopiedPrompt] = useState(false);
  const [showPromptPreview, setShowPromptPreview] = useState(false);
  
  // Import Progress
  const [importing, setImporting] = useState(false);
  const [importProgress, setImportProgress] = useState(0);
  const [importStats, setImportStats] = useState({ success: 0, rejected: 0, total: 0 });
  const [fileName, setFileName] = useState('');
  const [importBatchId, setImportBatchId] = useState(/** @type {string | null} */ (null));
  const [readingFile, setReadingFile] = useState(false);

  const fileInputRef = useRef(/** @type {HTMLInputElement | null} */ (null));
  const activeFileReaderRef = useRef(/** @type {FileReader | null} */ (null));
  const fileReadGenerationRef = useRef(0);
  const importInFlightRef = useRef(false);
  const questionBankRef = useRef(questionBank);

  useEffect(() => {
    fetchHistory();
  }, []);

  useEffect(() => () => {
    fileReadGenerationRef.current += 1;
    activeFileReaderRef.current?.abort();
    activeFileReaderRef.current = null;
  }, []);

  useEffect(() => {
    questionBankRef.current = questionBank;
    setQuestions(previous => previous.length > 0
      ? validateImportQuestions(previous, questionBank)
      : previous);
    // Also re-runs when the configured subject list arrives or changes.
  }, [questionBank, validateImportQuestions]);

  useEffect(() => {
    if (!hasParsedData || questions.length !== 0) return;
    setHasParsedData(false);
    setImportBatchId(null);
    setFileName('');
    setFilterTab('ALL');
  }, [hasParsedData, questions.length]);

  const fetchHistory = async () => {
    setLoadingHistory(true);
    setHistoryError('');
    try {
      const { data, error } = await supabase
        .from('import_history')
        .select('*')
        .order('imported_at', { ascending: false })
        .limit(100);
      if (error) throw error;
      setImportHistory(data || []);
    } catch (err) {
      console.error("Error fetching import history:", err);
      setHistoryError('Import history could not be loaded. Check the connection and your administrator session.');
    } finally {
      setLoadingHistory(false);
    }
  };

  const handleCopyPrompt = async () => {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(conversionPrompt);
      } else {
        const textarea = window.document.createElement('textarea');
        textarea.value = conversionPrompt;
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        window.document.body.appendChild(textarea);
        textarea.focus();
        textarea.select();
        window.document.execCommand('copy');
        window.document.body.removeChild(textarea);
      }
      setCopiedPrompt(true);
      setTimeout(() => setCopiedPrompt(false), 2500);
    } catch (err) {
      console.error('Failed to copy prompt:', err);
    }
  };

  // Drag and Drop handlers
  /** @param {import('react').DragEvent<HTMLElement>} e */
  const handleDrag = (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === "dragenter" || e.type === "dragover") {
      setDragActive(true);
    } else if (e.type === "dragleave") {
      setDragActive(false);
    }
  };

  /** @param {import('react').DragEvent<HTMLElement>} e */
  const handleDrop = async (e) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);
    if (/** @type {number} */ (e.dataTransfer.files?.length) > 1) {
      await customAlert('Drop one JSON file at a time.');
    } else if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      processFile(e.dataTransfer.files[0]);
    }
  };

  /** @param {import('react').ChangeEvent<HTMLInputElement>} e */
  const handleFileChange = (e) => {
    if (e.target.files && e.target.files[0]) {
      processFile(e.target.files[0]);
    }
    e.target.value = '';
  };

  /** @param {File} file */
  const processFile = (file) => {
    if (importInFlightRef.current) {
      customAlert('Wait for the current import to finish before selecting another file.');
      return;
    }
    const fileValidation = validateImportFile(file);
    if (!fileValidation.valid) {
      customAlert(fileValidation.error);
      return;
    }

    activeFileReaderRef.current?.abort();
    const generation = fileReadGenerationRef.current + 1;
    fileReadGenerationRef.current = generation;
    const reader = new FileReader();
    activeFileReaderRef.current = reader;
    setReadingFile(true);
    reader.onload = async (e) => {
      if (generation !== fileReadGenerationRef.current) return;
      try {
        const validatedQuestions = parseImportJsonText(
          /** @type {FileReader} */ (e.target).result,
          questionBankRef.current,
          { requireExplicitApproval: true, allowedSubjects: subjectList }
        );
        if (generation !== fileReadGenerationRef.current) return;
        setQuestions(validatedQuestions.map(question => ({ ...question, id: crypto.randomUUID() })));
        setHasParsedData(true);
        setFileName(fileValidation.fileName);
        setImportBatchId(crypto.randomUUID());
        setFilterTab('ALL');
        setImportProgress(0);
        setImportStats({ success: 0, rejected: 0, total: 0 });
      } catch (err) {
        await customAlert(err instanceof Error ? err.message : 'Invalid file format. Please upload a valid JSON file.');
      } finally {
        if (generation === fileReadGenerationRef.current) {
          activeFileReaderRef.current = null;
          setReadingFile(false);
        }
      }
    };
    reader.onerror = async () => {
      if (generation !== fileReadGenerationRef.current) return;
      activeFileReaderRef.current = null;
      setReadingFile(false);
      await customAlert('The JSON file could not be read. Select it again and retry.');
    };
    reader.onabort = () => {};
    try {
      reader.readAsText(file, 'UTF-8');
    } catch (error) {
      activeFileReaderRef.current = null;
      setReadingFile(false);
      customAlert(`The JSON file could not be read: ${/** @type {Error} */ (error).message}`);
    }
  };

  // Edit Handlers
  /**
   * @param {string} id
   * @param {string} field
   * @param {unknown} value
   */
  const handleUpdateQuestionField = (id, field, value) => {
    setQuestions(previous => validateImportQuestions(
      previous.map(question => {
        if (question.id !== id) return question;
        if (field === 'type' && value === 'NUMERICAL') {
          return { ...question, type: value, options: [], correctAnswer: '' };
        }
        if (field === 'type' && value === 'MCQ') {
          return { ...question, type: value, options: ['', '', '', ''], correctAnswer: '' };
        }
        return { ...question, [field]: value };
      }),
      questionBank
    ));
  };

  /**
   * @param {string} qId
   * @param {number} optIdx
   * @param {string} val
   */
  const handleUpdateOption = (qId, optIdx, val) => {
    const q = questions.find(item => item.id === qId);
    if (!q) return;
    const newOptions = [...q.options];
    newOptions[optIdx] = val;
    handleUpdateQuestionField(qId, 'options', newOptions);
  };

  /** @param {string} id */
  const handleDeleteQuestion = (id) => {
    setQuestions(previous => {
      const remaining = previous.filter(question => question.id !== id);
      return remaining.length > 0 ? validateImportQuestions(remaining, questionBankRef.current) : [];
    });
  };

  /** @param {string} id */
  const toggleApproval = (id) => {
    setQuestions(prev => prev.map(q => {
      if (q.id === id) {
        return q.warnings.length === 0 ? { ...q, approved: !q.approved } : q;
      }
      return q;
    }));
  };

  const approveAllValid = () => {
    setQuestions(prev => prev.map(q => {
      if (q.warnings.length === 0) {
        return { ...q, approved: true };
      }
      return q;
    }));
  };

  const startImport = async () => {
    if (importInFlightRef.current) return;
    importInFlightRef.current = true;
    let importStarted = false;
    try {
      if (activeFileReaderRef.current) {
        await customAlert('Wait for the selected JSON file to finish loading before importing.');
        return;
      }
      const revalidatedQuestions = validateImportQuestions(questions, questionBank);
      setQuestions(revalidatedQuestions);
      const approvedQs = revalidatedQuestions.filter(q => q.approved && q.warnings.length === 0);
      if (approvedQs.length === 0) {
        await customAlert('No approved questions to import.');
        return;
      }
      if (!importBatchId) {
        await customAlert('This import has no recovery batch ID. Select the JSON file again.');
        return;
      }
      if (!(await customConfirm(`Import ${approvedQs.length} approved questions into the Question Bank?`))) return;

      importStarted = true;
      setImporting(true);
      setImportProgress(0);
      setImportStats({ success: 0, rejected: 0, total: approvedQs.length });
      const payload = buildAtomicImportPayload(revalidatedQuestions);

      let confirmation;
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), IMPORT_REQUEST_TIMEOUT_MS);
        let response;
        try {
          response = await supabase.rpc('admin_import_questions', {
            batch_id_param: importBatchId,
            file_name_param: fileName,
            questions_param: payload
          }).abortSignal(controller.signal);
        } finally {
          clearTimeout(timeout);
        }
        const { data, error } = response;
        if (error) throw error;
        confirmation = validateImportConfirmation(data, approvedQs.length, importBatchId);
      } catch (error) {
        console.error('Atomic question import was not confirmed:', error);
        setImportStats({ success: 0, rejected: 0, total: approvedQs.length });
        await customAlert(`Import was not confirmed. The transaction cannot partially import a batch, but it may have committed before the connection failed. Keep this page open and retry the same batch safely.\n\n${/** @type {Error} */ (error).message}`);
        return;
      }

      const { imported, idempotent } = confirmation;
      setImportProgress(100);
      setImportStats({ success: imported, rejected: 0, total: approvedQs.length });
      const remainingQuestions = revalidatedQuestions.filter(question => !question.approved);
      if (remainingQuestions.length === 0) {
        setHasParsedData(false);
        setQuestions([]);
        setImportBatchId(null);
        setFileName('');
      } else {
        setQuestions(validateImportQuestions(remainingQuestions, questionBankRef.current));
        setImportBatchId(crypto.randomUUID());
      }
      await customAlert(`${idempotent ? 'Import already completed safely.' : 'Import complete!'}\nSuccessfully imported: ${imported}\nFailed: 0`);

      const refreshOutcomes = await Promise.allSettled([refreshQuestionBank(), fetchHistory()]);
      if (refreshOutcomes.some(outcome => outcome.status === 'rejected')) {
        await customAlert('The import is committed, but the refreshed Question Bank could not be loaded. Do not import the same questions with a new file; retry the page refresh when the connection recovers.');
      }
    } finally {
      if (importStarted) setImporting(false);
      importInFlightRef.current = false;
    }
  };

  const handleExportFailedRows = () => {
    const failedRowsJson = exportFailedImportRows(questions);
    const blob = new Blob([failedRowsJson], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `failed-import-rows-${Date.now()}.json`;
    document.body.appendChild(a);
    try {
      a.click();
    } finally {
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 0);
    }
  };

  const handleRevalidateAll = () => {
    const revalidated = validateImportQuestions(questions, questionBank);
    setQuestions(revalidated);
    const stillFailing = revalidated.filter(q => q.warnings.length > 0).length;
    if (stillFailing === 0) {
      customAlert("All questions are now valid and ready to import!");
    } else {
      customAlert(`Re-validation complete: ${revalidated.length - stillFailing} valid, ${stillFailing} still need attention.`);
    }
  };

  const validCount = questions.filter(q => q.warnings.length === 0).length;
  const failedCount = questions.filter(q => q.warnings.length > 0).length;
  const approvedCount = questions.filter(q => q.approved && q.warnings.length === 0).length;

  const displayedQuestions = questions.filter(q => {
    if (filterTab === 'VALID') return q.warnings.length === 0;
    if (filterTab === 'FAILED') return q.warnings.length > 0;
    return true;
  });

  // Purely presentational: which step of the flow the administrator is on.
  const currentStep = !hasParsedData ? 2 : approvedCount === 0 ? 3 : 4;

  /**
   * @param {boolean} active
   * @param {PillTone} tone
   */
  const filterPillClass = (active, tone) => cn(
    'inline-flex h-7 items-center gap-1 rounded-full border px-3 text-xs font-semibold transition-colors',
    active
      ? {
          neutral: 'border-slate-900 bg-slate-900 text-white',
          success: 'border-emerald-600 bg-emerald-600 text-white',
          warning: 'border-amber-500 bg-amber-500 text-white'
        }[tone]
      : {
          neutral: 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50',
          success: 'border-emerald-200 bg-white text-emerald-700 hover:bg-emerald-50',
          warning: 'border-amber-200 bg-white text-amber-700 hover:bg-amber-50'
        }[tone]
  );

  return (
    <div className="animate-fade-in flex flex-col gap-6">

      {/* Header with step indicator */}
      <Card>
        <CardContent className="flex flex-col gap-5">
          <div className="flex min-w-0 items-start gap-3">
            <div className="grid size-10 shrink-0 place-items-center rounded-xl bg-brand-50 text-brand-600 ring-1 ring-brand-100">
              <FileJson className="size-5" aria-hidden="true" />
            </div>
            <div className="min-w-0">
              <h2 className="text-lg font-semibold tracking-tight text-slate-900">Reviewed JSON Import</h2>
              <p className="mt-0.5 text-sm leading-relaxed text-slate-500">
                This portal accepts reviewed JSON only. It does not read PDFs, images, OCR output, documents, or invoke an AI service.
              </p>
            </div>
          </div>

          <ol className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4" aria-label="Import steps">
            {IMPORT_STEPS.map((label, index) => {
              const step = index + 1;
              const done = step < currentStep;
              const active = step === currentStep;
              return (
                <li
                  key={label}
                  aria-current={active ? 'step' : undefined}
                  className={cn(
                    'flex items-center gap-3 rounded-xl border px-3 py-2.5 text-sm transition-colors',
                    active ? 'border-brand-200 bg-brand-50 text-brand-900' : done ? 'border-emerald-200 bg-emerald-50/60 text-emerald-900' : 'border-slate-200 bg-white text-slate-500'
                  )}
                >
                  <span
                    className={cn(
                      'grid size-7 shrink-0 place-items-center rounded-full text-xs font-bold',
                      active ? 'bg-brand-600 text-white' : done ? 'bg-emerald-600 text-white' : 'bg-slate-100 text-slate-500'
                    )}
                    aria-hidden="true"
                  >
                    {done ? <Check className="size-4" /> : step}
                  </span>
                  <span className="font-medium">{label}</span>
                </li>
              );
            })}
          </ol>
        </CardContent>
      </Card>

      {/* Upper Area: reviewed schema guidance and JSON upload */}
      <div className="grid gap-6 lg:grid-cols-2">

        {/* Downloadable example/schema and external-conversion boundary */}
        <Card className="flex flex-col">
          <CardHeader>
            <div className="min-w-0 flex-1 basis-64">
              <p className="text-xs font-semibold uppercase tracking-wide text-brand-700">Step 1 · Prepare JSON</p>
              <h3 className="mt-1 flex items-center gap-2 text-base font-semibold text-slate-900">
                <Sparkles className="size-5 text-slate-500" aria-hidden="true" />
                AI Conversion Prompt
              </h3>
              <CardDescription>
                Copy this prompt to ChatGPT, Gemini, Claude, or DeepSeek to convert your exam documents into uploadable JSON.
              </CardDescription>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                variant={copiedPrompt ? 'success' : 'primary'}
                onClick={handleCopyPrompt}
                aria-label={copiedPrompt ? 'Prompt copied to clipboard' : 'Copy AI conversion prompt'}
              >
                {copiedPrompt ? (
                  <>
                    <Check aria-hidden="true" />
                    Copied!
                  </>
                ) : (
                  <>
                    <Copy aria-hidden="true" />
                    Copy Prompt
                  </>
                )}
              </Button>
              <Button size="sm" variant="secondary" onClick={() => setShowPromptPreview(prev => !prev)} aria-expanded={showPromptPreview}>
                {showPromptPreview ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}
                {showPromptPreview ? 'Hide Prompt' : 'View Prompt'}
              </Button>
            </div>
          </CardHeader>

          <CardContent className="flex flex-1 flex-col gap-4">
            {showPromptPreview && (
              <pre className="theme-island max-h-64 overflow-y-auto whitespace-pre-wrap break-words rounded-xl bg-slate-900 p-4 font-mono text-xs leading-relaxed text-slate-200">
                {conversionPrompt}
              </pre>
            )}

            {/* Quick Access AI Services */}
            <div>
              <div className="mb-2 flex flex-wrap items-center justify-between gap-1.5">
                <span className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-slate-500">
                  <Globe className="size-3.5" aria-hidden="true" />
                  Open External AI Assistant:
                </span>
                <span className="text-xs text-slate-400">
                  Opens in new tab • sign in with your account
                </span>
              </div>

              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-2 xl:grid-cols-4">
                {EXTERNAL_ASSISTANTS.map(assistant => (
                  <a
                    key={assistant.name}
                    href={assistant.href}
                    target="_blank"
                    rel="noopener noreferrer"
                    title={assistant.title}
                    className="group flex items-center justify-between gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-slate-700 no-underline shadow-sm transition-colors hover:border-brand-300 hover:bg-brand-50 hover:text-brand-800"
                  >
                    <span className="flex items-center gap-2">
                      <Bot className="size-4 text-slate-400 group-hover:text-brand-600" aria-hidden="true" />
                      {assistant.name}
                    </span>
                    <ExternalLink className="size-3.5 text-slate-400 group-hover:text-brand-600" aria-hidden="true" />
                  </a>
                ))}
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Drag and Drop Zone */}
        <Card className="flex flex-col">
          <CardHeader>
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-brand-700">Step 2 · Upload &amp; validate</p>
              <h3 className="mt-1 flex items-center gap-2 text-base font-semibold text-slate-900">
                <FileUp className="size-5 text-slate-500" aria-hidden="true" />
                Upload reviewed JSON
              </h3>
            </div>
          </CardHeader>
          <CardContent className="flex flex-1 flex-col">
            <div
              role="button"
              tabIndex={importing ? -1 : 0}
              aria-disabled={importing}
              aria-busy={readingFile}
              aria-label="Select one JSON question file"
              onDragEnter={handleDrag}
              onDragOver={handleDrag}
              onDragLeave={handleDrag}
              onDrop={handleDrop}
              className={cn(
                'flex min-h-64 flex-1 cursor-pointer flex-col items-center justify-center rounded-2xl border-2 border-dashed px-6 py-8 text-center transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600',
                dragActive ? 'border-brand-500 bg-brand-50' : 'border-slate-300 bg-slate-50/60 hover:border-brand-400 hover:bg-brand-50/40',
                importing && 'cursor-not-allowed opacity-60'
              )}
              onClick={() => !importing && fileInputRef.current?.click()}
              onKeyDown={(event) => {
                if (!importing && (event.key === 'Enter' || event.key === ' ')) {
                  event.preventDefault();
                  fileInputRef.current?.click();
                }
              }}
            >
              <div className={cn('mb-4 grid size-14 place-items-center rounded-full bg-white shadow-card ring-1', dragActive ? 'text-brand-600 ring-brand-200' : 'text-slate-400 ring-slate-200')}>
                <UploadCloud className="size-7" aria-hidden="true" />
              </div>
              <h3 className="mb-1 text-base font-semibold text-slate-900">
                Drag and Drop your JSON File here
              </h3>
              <p className="mb-4 text-sm text-slate-500">
                or <span className="font-semibold text-brand-700">click to browse</span> (maximum 5 MB and {MAX_IMPORT_QUESTIONS} questions)
              </p>
              <input
                type="file"
                ref={fileInputRef}
                onChange={handleFileChange}
                accept=".json,application/json"
                disabled={importing}
                className="hidden"
              />
              {readingFile && (
                <p role="status" className="flex items-center gap-2 text-sm font-semibold text-brand-700">
                  <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                  Reading and validating file…
                </p>
              )}
              {fileName && (
                <Badge variant="brand" className="max-w-full py-1 text-sm">
                  <FileJson aria-hidden="true" />
                  <span className="truncate">Selected: {fileName}</span>
                </Badge>
              )}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Progress Overlay during Import */}
      {importing && (
        <AccessibleModal labelledBy="question-import-progress-title" maxWidth="450px">
          <div aria-busy="true" className="text-left">
            <div className="mb-4 grid size-12 place-items-center rounded-full bg-brand-50 text-brand-600 ring-1 ring-brand-100">
              <Loader2 className="size-6 animate-spin" aria-hidden="true" />
            </div>
            <h3 id="question-import-progress-title" className="text-lg font-semibold text-slate-900">Importing Questions...</h3>
            <p className="mt-1 text-sm leading-relaxed text-slate-600">
              Saving the complete import and audit record as one protected transaction. Please keep the window open.
            </p>
            <div
              role="progressbar"
              aria-label="Question import progress"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={importProgress}
              className="my-5 h-2.5 overflow-hidden rounded-full bg-slate-200"
            >
              <div className="h-full rounded-full bg-brand-600 transition-[width] duration-100 ease-out" style={{ width: `${importProgress}%` }}></div>
            </div>
            <div className="flex justify-between text-sm font-semibold text-slate-700 tabular-nums">
              <span>Progress: {importProgress}%</span>
              <span>{importStats.success} / {importStats.total} Success</span>
            </div>
          </div>
        </AccessibleModal>
      )}

      {/* Verification / Preview Section */}
      {hasParsedData && (
        <Card>
          <CardHeader className="gap-4">
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-brand-700">Step 3 · Review &amp; approve</p>
              <h2 className="mt-1 text-lg font-semibold tracking-tight text-slate-900">
                Review Questions ({questions.length} total)
              </h2>
              <div className="mt-2 flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => setFilterTab('ALL')}
                  aria-pressed={filterTab === 'ALL'}
                  className={filterPillClass(filterTab === 'ALL', 'neutral')}
                >
                  All ({questions.length})
                </button>
                <button
                  type="button"
                  onClick={() => setFilterTab('VALID')}
                  aria-pressed={filterTab === 'VALID'}
                  className={filterPillClass(filterTab === 'VALID', 'success')}
                >
                  Valid ({validCount})
                </button>
                <button
                  type="button"
                  onClick={() => setFilterTab('FAILED')}
                  aria-pressed={filterTab === 'FAILED'}
                  className={filterPillClass(filterTab === 'FAILED', 'warning')}
                >
                  Needs Review ({failedCount})
                </button>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="secondary" size="sm" onClick={handleRevalidateAll}>
                <RefreshCw aria-hidden="true" />
                Re-validate
              </Button>
              {failedCount > 0 && (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={handleExportFailedRows}
                  className="border-amber-200 text-amber-800 hover:border-amber-300 hover:bg-amber-50"
                >
                  <Download aria-hidden="true" />
                  Export Failed Rows ({failedCount})
                </Button>
              )}
              <Button variant="secondary" size="sm" onClick={approveAllValid}>
                <ListChecks aria-hidden="true" />
                Approve All Valid
              </Button>
              <Button
                variant="success"
                size="sm"
                onClick={startImport}
                disabled={importing || readingFile || approvedCount === 0}
              >
                <DatabaseZap aria-hidden="true" />
                Import Approved ({approvedCount})
              </Button>
            </div>
          </CardHeader>

          {/* Question List */}
          <CardContent>
            <div className="flex max-h-[560px] flex-col gap-4 overflow-y-auto pr-1">
              {displayedQuestions.length === 0 ? (
                <EmptyState icon={Filter} title="No questions match the current filter." className="py-10" />
              ) : (
                displayedQuestions.map((q, idx) => {
                  const hasWarnings = q.warnings.length > 0;
                  return (
                    <article
                      key={q.id}
                      className={cn(
                        'flex flex-col gap-4 rounded-xl border p-4 transition-colors sm:p-5',
                        hasWarnings
                          ? 'border-amber-200 bg-amber-50/30'
                          : q.approved
                            ? 'border-emerald-200 bg-emerald-50/30'
                            : 'border-slate-200 bg-white'
                      )}
                    >

                      {/* Top Line of question card */}
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <div className="flex flex-wrap items-center gap-2.5">
                          <Checkbox
                            checked={q.approved}
                            onChange={() => toggleApproval(q.id)}
                            disabled={hasWarnings}
                            aria-label={q.warnings.length > 0 ? `Resolve validation warnings before approving row ${q.rowNumber}` : `Approve row ${q.rowNumber}`}
                            className="disabled:cursor-not-allowed"
                          />
                          <span className="text-sm font-semibold text-slate-900">
                            Row #{q.rowNumber || q.question_number || (idx + 1)}
                          </span>
                          {hasWarnings ? (
                            <Badge variant="warning">
                              <AlertTriangle aria-hidden="true" />
                              Needs Review ({q.warnings.length})
                            </Badge>
                          ) : q.approved ? (
                            <Badge variant="success">
                              <CheckCircle2 aria-hidden="true" />
                              Approved
                            </Badge>
                          ) : (
                            <Badge variant="neutral">
                              <Circle aria-hidden="true" />
                              Valid
                            </Badge>
                          )}
                          <div className="w-36">
                            <Select
                              value={q.subject}
                              onChange={(e) => handleUpdateQuestionField(q.id, 'subject', e.target.value)}
                              aria-label={`Subject for row ${q.rowNumber}`}
                              className="h-8 text-xs"
                            >
                              {!subjectList.includes(q.subject) && <option value={q.subject}>{q.subject || 'Choose a subject…'} (not allowed)</option>}
                              {subjectList.map(subject => <option key={subject} value={subject}>{subject}</option>)}
                            </Select>
                          </div>
                          <div className="w-36">
                            <Select
                              value={q.type}
                              onChange={(e) => handleUpdateQuestionField(q.id, 'type', e.target.value)}
                              aria-label={`Question type for row ${q.rowNumber}`}
                              className="h-8 text-xs"
                            >
                              <option value="MCQ">MCQ</option>
                              <option value="NUMERICAL">NUMERICAL</option>
                            </Select>
                          </div>
                        </div>

                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleDeleteQuestion(q.id)}
                          aria-label={`Remove row ${q.rowNumber}`}
                          className="text-red-600 hover:bg-red-50 hover:text-red-700"
                        >
                          <Trash2 aria-hidden="true" />
                          Remove
                        </Button>
                      </div>

                      {/* Warning Messages */}
                      {hasWarnings && (
                        <div role="alert" className="flex flex-col gap-1 rounded-lg border border-amber-200 border-l-4 border-l-amber-500 bg-amber-50 px-4 py-2.5">
                          {q.warnings.map((w, wIdx) => (
                            <div key={wIdx} className="flex items-start gap-2 text-xs font-medium text-amber-900">
                              <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-amber-600" aria-hidden="true" />
                              <span>{w}</span>
                            </div>
                          ))}
                        </div>
                      )}

                      {/* Question Fields Inputs / Previews */}
                      <div className="grid gap-5 lg:grid-cols-2">

                        {/* Left Side: Editor Inputs */}
                        <div className="flex flex-col gap-3">
                          <Field label="Question Text" htmlFor={`import-question-text-${q.id}`}>
                            <Textarea
                              id={`import-question-text-${q.id}`}
                              value={q.text}
                              onChange={(e) => handleUpdateQuestionField(q.id, 'text', e.target.value)}
                              maxLength={10000}
                              rows={3}
                              className="min-h-20 resize-y"
                            />
                          </Field>

                          <div className="flex items-center gap-2">
                            <Checkbox
                              id={`has-img-${q.id}`}
                              checked={q.hasImageOrDiagram || false}
                              onChange={(e) => handleUpdateQuestionField(q.id, 'hasImageOrDiagram', e.target.checked)}
                            />
                            <label htmlFor={`has-img-${q.id}`} className="flex cursor-pointer items-center gap-1.5 text-sm font-medium text-amber-800">
                              <ImageIcon className="size-4 text-amber-600" aria-hidden="true" />
                              Contains Image or Chemistry Diagram
                            </label>
                          </div>
                          {q.hasImageOrDiagram && (
                            <p role="note" className="-mt-1 rounded-md bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-900">
                              After import, attach and verify the required private image in the Question Bank. The exam cannot be activated while required media is missing.
                            </p>
                          )}

                          {q.type === 'MCQ' ? (
                            <div className="flex flex-col gap-1.5">
                              <span className="text-sm font-medium text-slate-700">Options</span>
                              <div className="grid gap-2 sm:grid-cols-2">
                                {['A', 'B', 'C', 'D'].map((lbl, oIdx) => (
                                  <div key={lbl} className="flex items-center gap-2">
                                    <span className="grid size-6 shrink-0 place-items-center rounded-full bg-slate-100 text-xs font-bold text-slate-600">{lbl}</span>
                                    <Input
                                      type="text"
                                      value={q.options[oIdx] || ''}
                                      onChange={(e) => handleUpdateOption(q.id, oIdx, e.target.value)}
                                      maxLength={5000}
                                      aria-label={`Option ${lbl} for row ${q.rowNumber}`}
                                      placeholder={`Option ${lbl}...`}
                                      className="h-8 text-xs"
                                    />
                                  </div>
                                ))}
                              </div>
                            </div>
                          ) : (
                            <div className="flex items-center justify-center gap-2 rounded-lg border border-dashed border-slate-300 bg-slate-50 px-3 py-2 text-xs italic text-slate-500">
                              <Hash className="size-3.5" aria-hidden="true" />
                              Numerical Question - No options required.
                            </div>
                          )}

                          <Field label="Correct Answer" htmlFor={`import-correct-answer-${q.id}`}>
                            {q.type === 'MCQ' ? (
                              <Select
                                id={`import-correct-answer-${q.id}`}
                                value={q.correctAnswer}
                                onChange={(e) => handleUpdateQuestionField(q.id, 'correctAnswer', e.target.value)}
                                className="h-9 text-sm"
                              >
                                <option value="" disabled>Select the correct option</option>
                                <option value="0">A</option>
                                <option value="1">B</option>
                                <option value="2">C</option>
                                <option value="3">D</option>
                              </Select>
                            ) : (
                              <Input
                                id={`import-correct-answer-${q.id}`}
                                type="text"
                                value={q.correctAnswer}
                                onChange={(e) => handleUpdateQuestionField(q.id, 'correctAnswer', e.target.value)}
                                inputMode="decimal"
                                maxLength={100}
                                placeholder="Correct numerical value..."
                                className="h-9 tabular-nums"
                              />
                            )}
                          </Field>
                        </div>

                        {/* Right Side: Math Rendered Preview */}
                        <div className="flex flex-col gap-2 overflow-hidden rounded-xl border border-slate-200 bg-slate-50 p-4">
                          <span className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                            <Eye className="size-3.5" aria-hidden="true" />
                            LaTeX Math Preview
                          </span>

                          <div className="flex flex-1 flex-col gap-3 overflow-y-auto">
                            <div className="text-sm text-slate-900">
                              <strong>Text:</strong> <MathRenderer text={q.text || '(No text entered)'} />
                            </div>

                            {q.type === 'MCQ' && (
                              <div className="flex flex-col gap-1.5 text-sm text-slate-600">
                                {['A', 'B', 'C', 'D'].map((lbl, oIdx) => {
                                  const isCorrect = q.correctAnswer === String(oIdx);
                                  return (
                                    <div
                                      key={lbl}
                                      className={cn(
                                        'flex items-start gap-2 rounded-md px-2 py-1',
                                        isCorrect && 'bg-emerald-50 font-semibold text-emerald-700 ring-1 ring-emerald-200'
                                      )}
                                    >
                                      <span className="shrink-0">{lbl})</span>
                                      <span className="min-w-0"><MathRenderer text={q.options[oIdx] || '(empty)'} /></span>
                                      {isCorrect && <CheckCircle2 className="ml-auto mt-0.5 size-4 shrink-0 text-emerald-600" aria-label="Correct answer" />}
                                    </div>
                                  );
                                })}
                              </div>
                            )}
                          </div>
                        </div>

                      </div>

                    </article>
                  );
                })
              )}
            </div>
          </CardContent>
        </Card>
      )}

      {/* History Log Section */}
      <Card>
        <CardHeader>
          <div>
            <CardTitle>
              <History aria-hidden="true" />
              Import History
            </CardTitle>
            <CardDescription>Showing the latest 100 import batches.</CardDescription>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {historyError && <Alert variant="danger" role="alert">{historyError}</Alert>}

          {loadingHistory ? (
            <LoadingBlock label="Loading history..." className="py-8" />
          ) : importHistory.length === 0 ? (
            <EmptyState icon={Inbox} title="No questions have been imported yet." className="py-10" />
          ) : (
            <Table>
              <THead>
                <tr>
                  <TH>File Name</TH>
                  <TH>Date / Time</TH>
                  <TH className="text-right">Total Detected</TH>
                  <TH className="text-right">Successfully Imported</TH>
                  <TH className="text-right">Rejected / Failed</TH>
                  <TH>Status</TH>
                </tr>
              </THead>
              <TBody>
                {importHistory.map(row => (
                  <TR key={row.id}>
                    <TD className="font-semibold text-slate-900">{row.file_name}</TD>
                    <TD className="whitespace-nowrap text-slate-500 tabular-nums">
                      {new Date(row.imported_at).toLocaleString()}
                    </TD>
                    <TD className="text-right tabular-nums">{row.total_questions}</TD>
                    <TD className="text-right font-semibold text-emerald-700 tabular-nums">{row.successful_imports}</TD>
                    <TD className={cn('text-right tabular-nums', row.rejected_questions > 0 ? 'font-semibold text-red-600' : 'text-slate-700')}>
                      {row.rejected_questions}
                    </TD>
                    <TD>
                      <Badge variant={row.status === 'Success' ? 'success' : row.status === 'Partial' ? 'warning' : 'danger'}>
                        {row.status}
                      </Badge>
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </CardContent>
      </Card>

    </div>
  );
};

export default ReviewedJsonImporter;
