import { useCallback, useEffect, useRef, useState } from 'react';
import MathRenderer from './MathRenderer';
import StorageImage from './StorageImage';
import {
  CANDIDATE_NUMERICAL_MAX_LENGTH,
  NUMERICAL_ABSOLUTE_TOLERANCE,
  validateNumericalAnswer
} from '../numericalAnswerPolicy';

const QuestionPanel = ({ 
  question, 
  questionIndex, 
  selectedOption, 
  setSelectedOption,
  handleAction,
  goNext,
  goPrev,
  submitExam,
  submitButtonRef,
  isFirstQuestionOfExam,
  isLastQuestionOfExam,
  disabled = false
}) => {
  const isNumericalQuestion = question?.type === 'NUMERICAL' || !question?.options || question.options.length === 0;
  const [numericalDraft, setNumericalDraft] = useState(() => selectedOption == null ? '' : String(selectedOption));
  const [numericalError, setNumericalError] = useState('');
  const draftQuestionIdRef = useRef(question?.id);

  useEffect(() => {
    const externalValue = selectedOption == null ? '' : String(selectedOption);
    if (draftQuestionIdRef.current !== question?.id) {
      draftQuestionIdRef.current = question?.id;
      setNumericalDraft(externalValue);
      setNumericalError('');
      return;
    }
    // Preserve a local transient draft such as "-" or ".", but accept server
    // reconciliation and external clearing whenever the current draft is valid.
    const currentDraft = validateNumericalAnswer(numericalDraft);
    if ((numericalDraft === '' || currentDraft.valid) && externalValue !== numericalDraft) {
      setNumericalDraft(externalValue);
      setNumericalError('');
    }
  }, [question?.id, selectedOption, numericalDraft]);

  const applyNumericalDraft = (value) => {
    if (disabled) return;
    const next = String(value);
    const validation = validateNumericalAnswer(next);
    setNumericalDraft(next);
    setNumericalError(validation.error);
    // Incomplete or invalid drafts never replace the last valid autosave.
    // Emptying the field is an intentional clear; malformed/intermediate text
    // stays local until it becomes a complete valid decimal.
    if (validation.valid) setSelectedOption(next);
    else if (validation.empty) setSelectedOption(null);
  };

  const clearResponse = useCallback(() => {
    if (disabled) return;
    setNumericalDraft('');
    setNumericalError('');
    setSelectedOption(null);
  }, [disabled, setSelectedOption]);

  const numericalDraftIsReady = useCallback(() => {
    if (!isNumericalQuestion || numericalDraft === '') return true;
    const validation = validateNumericalAnswer(numericalDraft);
    if (!validation.valid) {
      setNumericalError(validation.error || 'Finish entering the numerical value.');
      return false;
    }
    return true;
  }, [isNumericalQuestion, numericalDraft]);

  const performAction = useCallback((action) => {
    if (numericalDraftIsReady()) handleAction(action);
  }, [handleAction, numericalDraftIsReady]);

  const performSubmit = () => {
    if (numericalDraftIsReady()) submitExam();
  };

  useEffect(() => {
    if (disabled) return;

    const handleGlobalKeyDown = (e) => {
      const activeTag = document.activeElement?.tagName?.toLowerCase();
      const isTyping = activeTag === 'input' || activeTag === 'textarea';

      // Alt+S or Ctrl+Enter: Save & Next
      if ((e.altKey && (e.key === 's' || e.key === 'S')) || (e.ctrlKey && e.key === 'Enter')) {
        e.preventDefault();
        performAction('SAVE_NEXT');
        return;
      }

      // Alt+M: Save & Mark for Review
      if (e.altKey && (e.key === 'm' || e.key === 'M')) {
        e.preventDefault();
        performAction('SAVE_MARK');
        return;
      }

      // Alt+C: Clear response
      if (e.altKey && (e.key === 'c' || e.key === 'C')) {
        e.preventDefault();
        clearResponse();
        return;
      }

      // Arrow navigation when not typing in numerical text input
      if (!isTyping) {
        if (e.key === 'ArrowRight' || (e.altKey && (e.key === 'n' || e.key === 'N'))) {
          if (!isLastQuestionOfExam) {
            e.preventDefault();
            goNext();
          }
        } else if (e.key === 'ArrowLeft' || (e.altKey && (e.key === 'p' || e.key === 'P'))) {
          if (!isFirstQuestionOfExam) {
            e.preventDefault();
            goPrev();
          }
        }
      }
    };

    window.addEventListener('keydown', handleGlobalKeyDown);
    return () => window.removeEventListener('keydown', handleGlobalKeyDown);
  }, [disabled, performAction, clearResponse, goNext, goPrev, isFirstQuestionOfExam, isLastQuestionOfExam]);

  if (!question) return null;

  return (
    <div className="exam-question-panel" style={{ display: 'flex', flexDirection: 'column', height: '100%', flex: 1, backgroundColor: 'white', borderRight: '1px solid var(--border-color)', position: 'relative' }}>
      {/* Hidden Skip Links for Keyboard & Screen Reader Users */}
      <div className="sr-skip-nav">
        <a href="#question-prompt-text" className="sr-skip-link">Skip to question prompt</a>
        <a href="#question-action-bar" className="sr-skip-link">Skip to action buttons</a>
      </div>

      {/* Question Header */}
      <div style={{ padding: '15px 20px', borderBottom: '1px solid var(--border-color)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <h3 style={{ fontSize: '1.1rem', fontWeight: 'bold', margin: 0 }}>Question {questionIndex + 1}</h3>
          <span style={{ 
            fontSize: '0.75rem', 
            fontWeight: 'bold', 
            color: question.type === 'NUMERICAL' || !question.options || question.options.length === 0 ? 'var(--warning)' : 'var(--primary)', 
            backgroundColor: question.type === 'NUMERICAL' || !question.options || question.options.length === 0 ? 'rgba(245, 158, 11, 0.15)' : 'rgba(37, 99, 235, 0.1)', 
            padding: '3px 10px', 
            borderRadius: '12px',
            border: `1px solid ${question.type === 'NUMERICAL' || !question.options || question.options.length === 0 ? 'rgba(245, 158, 11, 0.3)' : 'rgba(37, 99, 235, 0.2)'}`
          }}>
            {question.type === 'NUMERICAL' || !question.options || question.options.length === 0 ? 'NUMERICAL VALUE TYPE' : 'MULTIPLE CHOICE'}
          </span>
        </div>
        <span aria-hidden="true" style={{ color: 'var(--text-muted)' }}>▼</span>
      </div>

      {/* Question Content */}
      <div className="exam-question-content" style={{ padding: '20px', flex: 1, overflowY: 'auto' }}>
        <p id="question-prompt-text" tabIndex={-1} style={{ fontSize: '1.1rem', marginBottom: '15px', lineHeight: '1.6', whiteSpace: 'pre-wrap' }}><MathRenderer text={question.text} /></p>
        
        {question.questionImageUrl && (
          <div style={{ marginBottom: '25px' }}>
            <StorageImage src={question.questionImageUrl} alt="Question context" style={{ maxWidth: '100%', maxHeight: '400px', borderRadius: '8px', border: '1px solid var(--border-color)', boxShadow: '0 2px 4px rgba(0,0,0,0.05)' }} />
          </div>
        )}
        
        {question.type === 'NUMERICAL' || !question.options || question.options.length === 0 ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '20px', maxWidth: '500px', marginTop: '10px' }}>
            <div style={{ padding: '15px', backgroundColor: 'rgba(59, 130, 246, 0.05)', borderRadius: '8px', borderLeft: '4px solid var(--primary)' }}>
              <p style={{ margin: 0, fontSize: '0.95rem', color: 'var(--text-main)' }}>
                <strong>Instructions:</strong> Enter an integer or decimal value (for example 5, -3.14, or 0.5). Scientific notation and spaces are not accepted. Values within {NUMERICAL_ABSOLUTE_TOLERANCE} of the answer are graded as correct.
              </p>
            </div>
            
            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
              <label htmlFor="numerical-answer" style={{ fontWeight: 'bold', color: 'var(--text-main)', fontSize: '1.05rem' }}>Your Numerical Answer:</label>
              <input
                id="numerical-answer"
                type="text"
                inputMode="decimal"
                placeholder="Enter numerical value..."
                disabled={disabled}
                maxLength={CANDIDATE_NUMERICAL_MAX_LENGTH}
                value={numericalDraft}
                aria-invalid={Boolean(numericalError)}
                aria-describedby="numerical-answer-help numerical-answer-error"
                onChange={(e) => {
                  applyNumericalDraft(e.target.value);
                }}
                style={{
                  padding: '14px 18px',
                  fontSize: '1.2rem',
                  fontWeight: 'bold',
                  border: '2px solid var(--primary)',
                  borderRadius: '8px',
                  outline: 'none',
                  boxShadow: '0 2px 8px rgba(37, 99, 235, 0.1)',
                  width: '100%',
                  backgroundColor: disabled ? '#f1f5f9' : 'white',
                  cursor: disabled ? 'not-allowed' : 'text',
                  color: 'var(--text-main)'
                }}
              />
              <span id="numerical-answer-help" style={{ fontSize: '0.82rem', color: 'var(--text-muted)' }}>
                Maximum {CANDIDATE_NUMERICAL_MAX_LENGTH} characters; decimal notation only. An unfinished edit does not replace your last valid saved answer.
              </span>
              {numericalError && <span id="numerical-answer-error" role="alert" style={{ color: 'var(--danger)', fontWeight: 700 }}>{numericalError}</span>}
            </div>

            {/* Virtual Keypad for JEE/GATE feel */}
            <div style={{ backgroundColor: '#f8fafc', padding: '15px', borderRadius: '8px', border: '1px solid var(--border-color)', boxShadow: '0 4px 6px -1px rgba(0, 0, 0, 0.05)', opacity: disabled ? 0.6 : 1, pointerEvents: disabled ? 'none' : 'auto' }}>
              <div style={{ fontSize: '0.85rem', color: 'var(--text-muted)', marginBottom: '10px', fontWeight: 'bold', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span>⌨️ Virtual Keypad</span>
                <span style={{ fontSize: '0.75rem', fontStyle: 'italic' }}>Click or type directly</span>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '8px' }}>
                {[1, 2, 3, 4, 5, 6, 7, 8, 9, '.', 0, '-'].map((key) => (
                  <button
                    key={key}
                    type="button"
                    disabled={disabled}
                    onClick={() => {
                      if (disabled) return;
                      const currentStr = numericalDraft;
                      if (key === '-' && currentStr.startsWith('-')) {
                        applyNumericalDraft(currentStr.substring(1));
                      } else if (key === '-' && !currentStr.startsWith('-')) {
                        applyNumericalDraft('-' + currentStr);
                      } else if (key === '.' && currentStr.includes('.')) {
                        // ignore double decimal
                      } else {
                        applyNumericalDraft(currentStr + key);
                      }
                    }}
                    style={{
                      padding: '12px',
                      fontSize: '1.1rem',
                      fontWeight: 'bold',
                      backgroundColor: 'white',
                      border: '1px solid var(--border-color)',
                      borderRadius: '6px',
                      cursor: disabled ? 'not-allowed' : 'pointer',
                      boxShadow: '0 1px 2px rgba(0,0,0,0.05)',
                      transition: 'all 0.1s'
                    }}
                    onMouseOver={(e) => !disabled && (e.currentTarget.style.backgroundColor = '#f1f5f9')}
                    onMouseOut={(e) => !disabled && (e.currentTarget.style.backgroundColor = 'white')}
                  >
                    {key}
                  </button>
                ))}
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', marginTop: '8px' }}>
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => {
                    if (disabled) return;
                    const currentStr = numericalDraft;
                    const newStr = currentStr.slice(0, -1);
                    applyNumericalDraft(newStr);
                  }}
                  style={{ padding: '10px', backgroundColor: '#fee2e2', color: '#dc2626', fontWeight: 'bold', border: '1px solid #fca5a5', borderRadius: '6px', cursor: disabled ? 'not-allowed' : 'pointer', transition: 'all 0.1s' }}
                  onMouseOver={(e) => !disabled && (e.currentTarget.style.backgroundColor = '#fecaca')}
                  onMouseOut={(e) => !disabled && (e.currentTarget.style.backgroundColor = '#fee2e2')}
                >
                  ⌫ Backspace
                </button>
                <button
                  type="button"
                  disabled={disabled}
                  onClick={clearResponse}
                  style={{ padding: '10px', backgroundColor: '#f1f5f9', color: '#475569', fontWeight: 'bold', border: '1px solid #cbd5e1', borderRadius: '6px', cursor: disabled ? 'not-allowed' : 'pointer', transition: 'all 0.1s' }}
                  onMouseOver={(e) => !disabled && (e.currentTarget.style.backgroundColor = '#e2e8f0')}
                  onMouseOut={(e) => !disabled && (e.currentTarget.style.backgroundColor = '#f1f5f9')}
                >
                  Clear All
                </button>
              </div>
            </div>
          </div>
        ) : (
          <div
            role="radiogroup"
            aria-labelledby="question-prompt-text"
            style={{ display: 'flex', flexDirection: 'column', gap: '15px', opacity: disabled ? 0.6 : 1 }}
          >
            {question.options.map((opt, idx) => (
              <label 
                key={idx} 
                style={{ 
                  display: 'flex', 
                  alignItems: 'center', 
                  padding: '12px', 
                  minHeight: '48px',
                  border: '1px solid var(--border-color)', 
                  borderRadius: '8px', 
                  cursor: disabled ? 'not-allowed' : 'pointer',
                  backgroundColor: selectedOption === idx ? 'rgba(37, 99, 235, 0.05)' : 'white',
                  borderColor: selectedOption === idx ? 'var(--primary)' : 'var(--border-color)',
                  transition: 'all 0.2s'
                }}
              >
                <input 
                  type="radio" 
                  name={`q-${question.id}`} 
                  checked={selectedOption === idx} 
                  disabled={disabled}
                  onChange={() => !disabled && setSelectedOption(idx)}
                  onKeyDown={(e) => {
                    if (disabled) return;
                    if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
                      e.preventDefault();
                      const next = (idx + 1) % question.options.length;
                      setSelectedOption(next);
                    } else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
                      e.preventDefault();
                      const prev = (idx - 1 + question.options.length) % question.options.length;
                      setSelectedOption(prev);
                    }
                  }}
                  style={{ marginRight: '15px', width: '20px', height: '20px', flexShrink: 0, cursor: disabled ? 'not-allowed' : 'pointer' }}
                />
                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  <span style={{ fontSize: '1.05rem', whiteSpace: 'pre-wrap' }}>
                    <strong>{String.fromCharCode(65 + idx)}.</strong> <MathRenderer text={opt} />
                  </span>
                  {question.optionImageUrls && question.optionImageUrls[idx] && (
                    <StorageImage src={question.optionImageUrls[idx]} alt={`Option ${String.fromCharCode(65 + idx)}`} style={{ maxWidth: '100%', maxHeight: '200px', borderRadius: '4px', border: '1px solid var(--border-color)', alignSelf: 'flex-start', marginTop: '5px' }} />
                  )}
                </div>
              </label>
            ))}
          </div>
        )}
      </div>

      {/* Sticky Bottom Action Bar */}
      <div id="question-action-bar" className="exam-action-bar" style={{ padding: '15px 20px', borderTop: '1px solid var(--border-color)', backgroundColor: 'var(--bg-color)' }}>
        <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', marginBottom: '15px' }}>
          <button className="btn-success" disabled={disabled} onClick={() => performAction('SAVE_NEXT')} title="Save response and advance (Alt+S or Ctrl+Enter)">Save & Next <span aria-hidden="true" style={{ fontSize: '0.75rem', opacity: 0.8 }}>(Alt+S)</span></button>
          <button className="btn-warning" disabled={disabled} onClick={() => performAction('SAVE_MARK')} title="Save response and mark for review (Alt+M)">Save & Mark for Review <span aria-hidden="true" style={{ fontSize: '0.75rem', opacity: 0.8 }}>(Alt+M)</span></button>
          <button className="btn-outline" disabled={disabled} onClick={clearResponse} title="Clear response for this question (Alt+C)">Clear Response <span aria-hidden="true" style={{ fontSize: '0.75rem', opacity: 0.8 }}>(Alt+C)</span></button>
          <button className="btn-info" disabled={disabled} onClick={() => performAction('MARK_NEXT')} title="Mark for review without saving response">Mark for Review & Next</button>
        </div>

        <div className="exam-navigation-actions" style={{ display: 'flex', justifyContent: 'space-between', borderTop: '1px solid #cbd5e1', paddingTop: '15px' }}>
          <button className="btn-outline" onClick={goPrev} disabled={isFirstQuestionOfExam} title="Previous question (Alt+P or ArrowLeft)">&lt;&lt; Back</button>
          <div style={{ display: 'flex', gap: '10px' }}>
            <button className="btn-outline" onClick={goNext} disabled={isLastQuestionOfExam} title="Next question (Alt+N or ArrowRight)">Next &gt;&gt;</button>
            <button ref={submitButtonRef} className="btn-success" onClick={performSubmit} style={{ fontWeight: 'bold' }}>Submit Exam</button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default QuestionPanel;
