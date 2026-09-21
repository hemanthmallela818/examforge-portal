import { useState, useEffect, useRef } from 'react';
import { supabase } from '../supabase';
import MathRenderer from './MathRenderer';
import { customAlert, customConfirm } from '../utils';
import AccessibleModal from './AccessibleModal';
import {
  MAX_IMPORT_QUESTIONS,
  IMPORT_EXAMPLE_DOCUMENT,
  IMPORT_JSON_SCHEMA_DOCUMENT,
  buildAtomicImportPayload,
  parseImportJsonText,
  validateImportQuestions,
  validateImportConfirmation,
  validateImportFile,
  exportFailedImportRows
} from '../importLogic';

const IMPORT_REQUEST_TIMEOUT_MS = 120000;

const ReviewedJsonImporter = ({ questionBank, refreshQuestionBank }) => {
  const [dragActive, setDragActive] = useState(false);
  const [hasParsedData, setHasParsedData] = useState(false);
  const [questions, setQuestions] = useState([]);
  const [filterTab, setFilterTab] = useState('ALL'); // 'ALL' | 'VALID' | 'FAILED'
  const [importHistory, setImportHistory] = useState([]);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [historyError, setHistoryError] = useState('');
  
  // Import Progress
  const [importing, setImporting] = useState(false);
  const [importProgress, setImportProgress] = useState(0);
  const [importStats, setImportStats] = useState({ success: 0, rejected: 0, total: 0 });
  const [fileName, setFileName] = useState('');
  const [importBatchId, setImportBatchId] = useState(null);
  const [readingFile, setReadingFile] = useState(false);

  const fileInputRef = useRef(null);
  const activeFileReaderRef = useRef(null);
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
  }, [questionBank]);

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

  const downloadJsonArtifact = (document, downloadName) => {
    const blob = new Blob([JSON.stringify(document, null, 2)], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = window.document.createElement('a');
    anchor.href = url;
    anchor.download = downloadName;
    window.document.body.appendChild(anchor);
    try {
      anchor.click();
    } finally {
      window.document.body.removeChild(anchor);
      setTimeout(() => URL.revokeObjectURL(url), 0);
    }
  };

  // Drag and Drop handlers
  const handleDrag = (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === "dragenter" || e.type === "dragover") {
      setDragActive(true);
    } else if (e.type === "dragleave") {
      setDragActive(false);
    }
  };

  const handleDrop = async (e) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);
    if (e.dataTransfer.files?.length > 1) {
      await customAlert('Drop one JSON file at a time.');
    } else if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      processFile(e.dataTransfer.files[0]);
    }
  };

  const handleFileChange = (e) => {
    if (e.target.files && e.target.files[0]) {
      processFile(e.target.files[0]);
    }
    e.target.value = '';
  };

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
          e.target.result,
          questionBankRef.current,
          { requireExplicitApproval: true }
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
      customAlert(`The JSON file could not be read: ${error.message}`);
    }
  };

  // Edit Handlers
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

  const handleUpdateOption = (qId, optIdx, val) => {
    const q = questions.find(item => item.id === qId);
    if (!q) return;
    const newOptions = [...q.options];
    newOptions[optIdx] = val;
    handleUpdateQuestionField(qId, 'options', newOptions);
  };

  const handleDeleteQuestion = (id) => {
    setQuestions(previous => {
      const remaining = previous.filter(question => question.id !== id);
      return remaining.length > 0 ? validateImportQuestions(remaining, questionBankRef.current) : [];
    });
  };

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
        await customAlert(`Import was not confirmed. The transaction cannot partially import a batch, but it may have committed before the connection failed. Keep this page open and retry the same batch safely.\n\n${error.message}`);
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

  const getStatusStyle = (q) => {
    if (q.warnings.length > 0) {
      return { border: '1px solid rgba(245, 158, 11, 0.4)', backgroundColor: 'rgba(245, 158, 11, 0.02)' };
    }
    return { border: '1px solid var(--border-color)' };
  };

  const validCount = questions.filter(q => q.warnings.length === 0).length;
  const failedCount = questions.filter(q => q.warnings.length > 0).length;
  const approvedCount = questions.filter(q => q.approved && q.warnings.length === 0).length;

  const displayedQuestions = questions.filter(q => {
    if (filterTab === 'VALID') return q.warnings.length === 0;
    if (filterTab === 'FAILED') return q.warnings.length > 0;
    return true;
  });

  return (
    <div className="animate-fade-in" style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
      
      {/* Upper Area: reviewed schema guidance and JSON upload */}
      <div className="responsive-two-column-grid" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '24px' }}>
        
        {/* Downloadable example/schema and external-conversion boundary */}
        <div style={{ backgroundColor: 'var(--panel-bg)', padding: '24px', borderRadius: '12px', border: '1px solid var(--border-color)', display: 'flex', flexDirection: 'column', gap: '15px' }}>
          <h2 style={{ margin: 0, color: '#1e293b', fontSize: '1.25rem', display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span>📋</span> Reviewed JSON Import
          </h2>
          <p style={{ margin: 0, color: '#475569', fontSize: '0.9rem', lineHeight: '1.5' }}>
            This portal accepts reviewed JSON only. It does not read PDFs, images, OCR output, documents, or invoke an AI service. If source material needs conversion, do that outside the portal, then verify every question, option, answer, subject, equation, and diagram indicator before approval.
          </p>

          <div style={{ border: '1px solid var(--border-color)', borderRadius: '8px', padding: '14px', backgroundColor: '#f8fafc' }}>
            <p style={{ margin: '0 0 12px', fontSize: '0.85rem', color: '#475569' }}>
              Start with the example and validate generated JSON against the schema. A row is never committed until it passes validation and an administrator explicitly approves it.
            </p>
            <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
              <button
                type="button"
                onClick={() => downloadJsonArtifact(IMPORT_EXAMPLE_DOCUMENT, 'reviewed-jee-question-import-example.json')}
                className="btn-primary"
                style={{ padding: '8px 12px', fontSize: '0.82rem' }}
              >
                Download JSON Example
              </button>
              <button
                type="button"
                onClick={() => downloadJsonArtifact(IMPORT_JSON_SCHEMA_DOCUMENT, 'reviewed-jee-question-import-v1.schema.json')}
                className="btn-outline"
                style={{ padding: '8px 12px', fontSize: '0.82rem' }}
              >
                Download JSON Schema
              </button>
            </div>
          </div>
        </div>

        {/* Drag and Drop Zone */}
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
          style={{ 
            border: `2px dashed ${dragActive ? 'var(--primary)' : 'var(--border-color)'}`, 
            backgroundColor: dragActive ? 'rgba(37, 99, 235, 0.05)' : 'var(--panel-bg)',
            borderRadius: '12px',
            padding: '24px',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            textAlign: 'center',
            cursor: 'pointer',
            transition: 'all 0.2s',
            minHeight: '260px'
          }}
          onClick={() => !importing && fileInputRef.current?.click()}
          onKeyDown={(event) => {
            if (!importing && (event.key === 'Enter' || event.key === ' ')) {
              event.preventDefault();
              fileInputRef.current?.click();
            }
          }}
        >
          <span style={{ fontSize: '3rem', marginBottom: '15px' }}>📁</span>
          <h3 style={{ margin: '0 0 8px 0', fontSize: '1.1rem', color: '#1e293b' }}>
            Drag and Drop your JSON File here
          </h3>
          <p style={{ margin: '0 0 15px 0', fontSize: '0.85rem', color: '#64748b' }}>
            or click to browse (maximum 5 MB and {MAX_IMPORT_QUESTIONS} questions)
          </p>
          <input 
            type="file" 
            ref={fileInputRef}
            onChange={handleFileChange}
            accept=".json,application/json"
            disabled={importing}
            style={{ display: 'none' }}
          />
          {readingFile && <p role="status" style={{ color: 'var(--primary)', fontWeight: 600 }}>Reading and validating file…</p>}
          {fileName && (
            <div style={{ backgroundColor: 'rgba(37, 99, 235, 0.1)', color: 'var(--primary)', padding: '5px 12px', borderRadius: '15px', fontSize: '0.85rem', fontWeight: 'bold' }}>
              Selected: {fileName}
            </div>
          )}
        </div>
      </div>

      {/* Progress Overlay during Import */}
      {importing && (
        <AccessibleModal labelledBy="question-import-progress-title" maxWidth="450px">
          <div aria-busy="true">
            <h3 id="question-import-progress-title" style={{ marginTop: 0 }}>Importing Questions...</h3>
            <p style={{ color: '#475569', fontSize: '0.9rem' }}>
              Saving the complete import and audit record as one protected transaction. Please keep the window open.
            </p>
            <div
              role="progressbar"
              aria-label="Question import progress"
              aria-valuemin="0"
              aria-valuemax="100"
              aria-valuenow={importProgress}
              style={{ height: '10px', backgroundColor: '#e2e8f0', borderRadius: '5px', overflow: 'hidden', margin: '20px 0' }}
            >
              <div style={{ height: '100%', backgroundColor: 'var(--primary)', width: `${importProgress}%`, transition: 'width 0.1s ease-out' }}></div>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.85rem', fontWeight: 'bold' }}>
              <span>Progress: {importProgress}%</span>
              <span>{importStats.success} / {importStats.total} Success</span>
            </div>
          </div>
        </AccessibleModal>
      )}

      {/* Verification / Preview Section */}
      {hasParsedData && (
        <div style={{ backgroundColor: 'var(--panel-bg)', padding: '24px', borderRadius: '12px', border: '1px solid var(--border-color)', display: 'flex', flexDirection: 'column', gap: '20px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid var(--border-color)', paddingBottom: '15px', flexWrap: 'wrap', gap: '10px' }}>
            <div>
              <h2 style={{ margin: 0, fontSize: '1.2rem', color: '#1e293b' }}>
                Review Questions ({questions.length} total)
              </h2>
              <div style={{ display: 'flex', gap: '8px', marginTop: '6px' }}>
                <button
                  onClick={() => setFilterTab('ALL')}
                  aria-pressed={filterTab === 'ALL'}
                  style={{
                    padding: '3px 10px',
                    borderRadius: '12px',
                    border: '1px solid #cbd5e1',
                    fontSize: '0.75rem',
                    fontWeight: 'bold',
                    cursor: 'pointer',
                    backgroundColor: filterTab === 'ALL' ? '#1e293b' : '#f8fafc',
                    color: filterTab === 'ALL' ? '#ffffff' : '#475569'
                  }}
                >
                  All ({questions.length})
                </button>
                <button
                  onClick={() => setFilterTab('VALID')}
                  aria-pressed={filterTab === 'VALID'}
                  style={{
                    padding: '3px 10px',
                    borderRadius: '12px',
                    border: '1px solid #cbd5e1',
                    fontSize: '0.75rem',
                    fontWeight: 'bold',
                    cursor: 'pointer',
                    backgroundColor: filterTab === 'VALID' ? 'var(--success)' : '#f8fafc',
                    color: filterTab === 'VALID' ? '#ffffff' : '#166534'
                  }}
                >
                  Valid ({validCount})
                </button>
                <button
                  onClick={() => setFilterTab('FAILED')}
                  aria-pressed={filterTab === 'FAILED'}
                  style={{
                    padding: '3px 10px',
                    borderRadius: '12px',
                    border: '1px solid #cbd5e1',
                    fontSize: '0.75rem',
                    fontWeight: 'bold',
                    cursor: 'pointer',
                    backgroundColor: filterTab === 'FAILED' ? '#f59e0b' : '#f8fafc',
                    color: filterTab === 'FAILED' ? '#ffffff' : '#b45309'
                  }}
                >
                  Needs Review ({failedCount})
                </button>
              </div>
            </div>
            <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
              <button 
                onClick={handleRevalidateAll}
                style={{ padding: '8px 14px', backgroundColor: '#f1f5f9', border: '1px solid #cbd5e1', color: '#334155', borderRadius: '6px', cursor: 'pointer', fontSize: '0.85rem', fontWeight: 'bold' }}
              >
                🔄 Re-validate
              </button>
              {failedCount > 0 && (
                <button 
                  onClick={handleExportFailedRows}
                  style={{ padding: '8px 14px', backgroundColor: '#fef3c7', border: '1px solid #f59e0b', color: '#b45309', borderRadius: '6px', cursor: 'pointer', fontSize: '0.85rem', fontWeight: 'bold' }}
                >
                  📥 Export Failed Rows ({failedCount})
                </button>
              )}
              <button 
                onClick={approveAllValid}
                style={{ padding: '8px 14px', backgroundColor: '#f1f5f9', border: '1px solid #cbd5e1', color: '#334155', borderRadius: '6px', cursor: 'pointer', fontSize: '0.85rem', fontWeight: 'bold' }}
              >
                Approve All Valid
              </button>
              <button 
                onClick={startImport}
                disabled={importing || readingFile || approvedCount === 0}
                style={{ padding: '8px 16px', backgroundColor: 'var(--success)', border: 'none', color: 'white', borderRadius: '6px', cursor: importing || readingFile || approvedCount === 0 ? 'not-allowed' : 'pointer', fontSize: '0.85rem', fontWeight: 'bold' }}
              >
                📥 Import Approved ({approvedCount})
              </button>
            </div>
          </div>

          {/* Question List */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '15px', maxHeight: '500px', overflowY: 'auto', paddingRight: '5px' }}>
            {displayedQuestions.length === 0 ? (
              <div style={{ textAlign: 'center', padding: '40px', color: '#64748b' }}>No questions match the current filter.</div>
            ) : (
              displayedQuestions.map((q, idx) => (
                <div 
                  key={q.id} 
                  style={{ 
                    padding: '18px', 
                    borderRadius: '8px', 
                    backgroundColor: q.approved ? 'rgba(34, 197, 94, 0.02)' : '#fff',
                    display: 'flex', 
                    flexDirection: 'column', 
                    gap: '15px',
                    transition: 'all 0.2s',
                    ...getStatusStyle(q)
                  }}
                >
                  
                  {/* Top Line of question card */}
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                      <input 
                        type="checkbox" 
                        checked={q.approved} 
                        onChange={() => toggleApproval(q.id)}
                        disabled={q.warnings.length > 0}
                        aria-label={q.warnings.length > 0 ? `Resolve validation warnings before approving row ${q.rowNumber}` : `Approve row ${q.rowNumber}`}
                        style={{ width: '16px', height: '16px', cursor: q.warnings.length > 0 ? 'not-allowed' : 'pointer' }}
                      />
                      <span style={{ fontWeight: 'bold', fontSize: '0.95rem', color: '#1e293b' }}>
                        Row #{q.rowNumber || q.question_number || (idx + 1)}
                      </span>
                      {q.warnings.length > 0 && (
                        <span style={{ backgroundColor: '#fef3c7', color: '#b45309', padding: '2px 8px', borderRadius: '4px', fontSize: '0.75rem', fontWeight: 600 }}>
                          Needs Review ({q.warnings.length})
                        </span>
                      )}
                      <select 
                        value={q.subject}
                        onChange={(e) => handleUpdateQuestionField(q.id, 'subject', e.target.value)}
                        aria-label={`Subject for row ${q.rowNumber}`}
                        style={{ padding: '3px 8px', borderRadius: '6px', border: '1px solid #cbd5e1', fontSize: '0.8rem', outline: 'none' }}
                      >
                        <option value="Physics">Physics</option>
                        <option value="Chemistry">Chemistry</option>
                        <option value="Mathematics">Mathematics</option>
                      </select>
                      <select 
                        value={q.type}
                        onChange={(e) => handleUpdateQuestionField(q.id, 'type', e.target.value)}
                        aria-label={`Question type for row ${q.rowNumber}`}
                        style={{ padding: '3px 8px', borderRadius: '6px', border: '1px solid #cbd5e1', fontSize: '0.8rem', outline: 'none' }}
                      >
                        <option value="MCQ">MCQ</option>
                        <option value="NUMERICAL">NUMERICAL</option>
                      </select>
                    </div>

                    <button 
                      onClick={() => handleDeleteQuestion(q.id)}
                      aria-label={`Remove row ${q.rowNumber}`}
                      style={{ background: 'none', border: 'none', color: 'var(--danger)', cursor: 'pointer', fontSize: '0.9rem', display: 'flex', alignItems: 'center', gap: '3px' }}
                    >
                      🗑️ Remove
                    </button>
                  </div>

                  {/* Warning Messages */}
                  {q.warnings.length > 0 && (
                    <div role="alert" style={{ display: 'flex', flexDirection: 'column', gap: '4px', backgroundColor: 'rgba(245, 158, 11, 0.1)', padding: '10px 15px', borderRadius: '6px', borderLeft: '4px solid #f59e0b' }}>
                      {q.warnings.map((w, wIdx) => (
                        <div key={wIdx} style={{ color: '#b45309', fontSize: '0.8rem', fontWeight: '500' }}>
                          ⚠️ {w}
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Question Fields Inputs / Previews */}
                  <div className="responsive-two-column-grid" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '20px' }}>
                    
                    {/* Left Side: Editor Inputs */}
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                      <div>
                        <label htmlFor={`import-question-text-${q.id}`} style={{ display: 'block', fontWeight: 'bold', fontSize: '0.8rem', color: '#475569', marginBottom: '4px' }}>Question Text</label>
                        <textarea 
                          id={`import-question-text-${q.id}`}
                          value={q.text}
                          onChange={(e) => handleUpdateQuestionField(q.id, 'text', e.target.value)}
                          maxLength={10000}
                          rows={3}
                          style={{ width: '100%', padding: '8px', border: '1px solid #cbd5e1', borderRadius: '6px', fontSize: '0.85rem', outline: 'none', resize: 'vertical' }}
                        />
                      </div>

                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '5px' }}>
                        <input 
                          type="checkbox" 
                          id={`has-img-${q.id}`}
                          checked={q.hasImageOrDiagram || false}
                          onChange={(e) => handleUpdateQuestionField(q.id, 'hasImageOrDiagram', e.target.checked)}
                          style={{ cursor: 'pointer', width: '15px', height: '15px' }}
                        />
                        <label htmlFor={`has-img-${q.id}`} style={{ fontWeight: 'bold', fontSize: '0.8rem', color: '#b45309', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '4px' }}>
                          ⚠️ Contains Image or Chemistry Diagram
                        </label>
                      </div>
                      {q.hasImageOrDiagram && (
                        <p role="note" style={{ margin: '-4px 0 4px', color: '#92400e', fontSize: '0.76rem', lineHeight: 1.4 }}>
                          After import, attach and verify the required private image in the Question Bank. The exam cannot be activated while required media is missing.
                        </p>
                      )}

                      {q.type === 'MCQ' ? (
                        <div>
                          <label style={{ display: 'block', fontWeight: 'bold', fontSize: '0.8rem', color: '#475569', marginBottom: '4px' }}>Options</label>
                          <div className="responsive-two-column-grid" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px' }}>
                            {['A', 'B', 'C', 'D'].map((lbl, oIdx) => (
                              <div key={lbl} style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                                <span style={{ fontWeight: 'bold', fontSize: '0.8rem', color: '#64748b' }}>{lbl}:</span>
                                <input 
                                  type="text" 
                                  value={q.options[oIdx] || ''}
                                  onChange={(e) => handleUpdateOption(q.id, oIdx, e.target.value)}
                                  maxLength={5000}
                                  aria-label={`Option ${lbl} for row ${q.rowNumber}`}
                                  placeholder={`Option ${lbl}...`}
                                  style={{ flex: 1, padding: '4px 6px', border: '1px solid #cbd5e1', borderRadius: '4px', fontSize: '0.8rem', outline: 'none' }}
                                />
                              </div>
                            ))}
                          </div>
                        </div>
                      ) : (
                        <div style={{ padding: '8px 12px', backgroundColor: '#f8fafc', borderRadius: '6px', border: '1px solid #cbd5e1', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                          <span style={{ fontSize: '0.8rem', color: '#64748b', fontStyle: 'italic' }}>Numerical Question - No options required.</span>
                        </div>
                      )}

                      <div>
                        <label htmlFor={`import-correct-answer-${q.id}`} style={{ display: 'block', fontWeight: 'bold', fontSize: '0.8rem', color: '#475569', marginBottom: '4px' }}>Correct Answer</label>
                        {q.type === 'MCQ' ? (
                          <select 
                            id={`import-correct-answer-${q.id}`}
                            value={q.correctAnswer}
                            onChange={(e) => handleUpdateQuestionField(q.id, 'correctAnswer', e.target.value)}
                            style={{ width: '100%', padding: '6px 8px', borderRadius: '6px', border: '1px solid #cbd5e1', fontSize: '0.8rem', outline: 'none' }}
                          >
                            <option value="" disabled>Select the correct option</option>
                            <option value="0">A</option>
                            <option value="1">B</option>
                            <option value="2">C</option>
                            <option value="3">D</option>
                          </select>
                        ) : (
                          <input 
                            id={`import-correct-answer-${q.id}`}
                            type="text" 
                            value={q.correctAnswer}
                            onChange={(e) => handleUpdateQuestionField(q.id, 'correctAnswer', e.target.value)}
                            inputMode="decimal"
                            maxLength={100}
                            placeholder="Correct numerical value..."
                            style={{ width: '100%', padding: '4px 8px', border: '1px solid #cbd5e1', borderRadius: '6px', fontSize: '0.8rem', outline: 'none' }}
                          />
                        )}
                      </div>
                    </div>

                    {/* Right Side: Math Rendered Preview */}
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', padding: '12px', border: '1px solid #e2e8f0', borderRadius: '6px', backgroundColor: '#f8fafc', overflow: 'hidden' }}>
                      <span style={{ fontWeight: 'bold', fontSize: '0.75rem', color: '#94a3b8', textTransform: 'uppercase' }}>LaTeX Math Preview</span>
                      
                      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '10px', overflowY: 'auto' }}>
                        <div style={{ fontSize: '0.9rem', color: '#1e293b' }}>
                          <strong>Text:</strong> <MathRenderer text={q.text || '(No text entered)'} />
                        </div>

                        {q.type === 'MCQ' && (
                          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '0.85rem', color: '#475569' }}>
                            {['A', 'B', 'C', 'D'].map((lbl, oIdx) => (
                              <div key={lbl} style={{ fontWeight: q.correctAnswer === String(oIdx) ? 'bold' : 'normal', color: q.correctAnswer === String(oIdx) ? 'var(--success)' : '#475569' }}>
                                {lbl}) <MathRenderer text={q.options[oIdx] || '(empty)'} />
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>

                  </div>

                </div>
              ))
            )}
          </div>
        </div>
      )}

      {/* History Log Section */}
      <div style={{ backgroundColor: 'var(--panel-bg)', padding: '24px', borderRadius: '12px', border: '1px solid var(--border-color)' }}>
        <h3 style={{ margin: '0 0 5px 0', fontSize: '1.1rem', color: '#1e293b' }}>Import History</h3>
        <p style={{ margin: '0 0 15px', color: '#64748b', fontSize: '0.8rem' }}>Showing the latest 100 import batches.</p>
        {historyError && <p role="alert" style={{ color: 'var(--danger)', fontWeight: 600 }}>{historyError}</p>}
        
        {loadingHistory ? (
          <div style={{ padding: '20px', textAlign: 'center', color: '#64748b' }}>Loading history...</div>
        ) : importHistory.length === 0 ? (
          <div style={{ padding: '20px', textAlign: 'center', color: '#64748b', fontSize: '0.9rem', border: '1px dashed #cbd5e1', borderRadius: '8px' }}>
            No questions have been imported yet.
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.9rem', textAlign: 'left' }}>
              <thead>
                <tr style={{ borderBottom: '2px solid #e2e8f0', color: '#64748b' }}>
                  <th style={{ padding: '10px 8px' }}>File Name</th>
                  <th style={{ padding: '10px 8px' }}>Date / Time</th>
                  <th style={{ padding: '10px 8px' }}>Total Detected</th>
                  <th style={{ padding: '10px 8px' }}>Successfully Imported</th>
                  <th style={{ padding: '10px 8px' }}>Rejected / Failed</th>
                  <th style={{ padding: '10px 8px' }}>Status</th>
                </tr>
              </thead>
              <tbody>
                {importHistory.map(row => (
                  <tr key={row.id} style={{ borderBottom: '1px solid #edf2f7', color: '#334155' }}>
                    <td style={{ padding: '12px 8px', fontWeight: 'bold' }}>{row.file_name}</td>
                    <td style={{ padding: '12px 8px' }}>
                      {new Date(row.imported_at).toLocaleString()}
                    </td>
                    <td style={{ padding: '12px 8px' }}>{row.total_questions}</td>
                    <td style={{ padding: '12px 8px', color: 'var(--success)', fontWeight: 'bold' }}>{row.successful_imports}</td>
                    <td style={{ padding: '12px 8px', color: row.rejected_questions > 0 ? 'var(--danger)' : '#334155' }}>
                      {row.rejected_questions}
                    </td>
                    <td style={{ padding: '12px 8px' }}>
                      <span 
                        style={{ 
                          fontSize: '0.75rem', fontWeight: 'bold', 
                          padding: '3px 8px', borderRadius: '10px',
                          color: row.status === 'Success' ? '#15803d' : row.status === 'Partial' ? '#b45309' : '#b91c1c',
                          backgroundColor: row.status === 'Success' ? '#dcfce7' : row.status === 'Partial' ? '#fef3c7' : '#fee2e2'
                        }}
                      >
                        {row.status}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

    </div>
  );
};

export default ReviewedJsonImporter;
