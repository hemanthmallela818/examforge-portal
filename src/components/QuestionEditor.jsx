import { useState, useRef } from 'react';
import ReactDOM from 'react-dom';
import { customAlert, customConfirm } from '../utils';
import MathRenderer from './MathRenderer';
import { supabase } from '../supabase';
import StorageImage from './StorageImage';
import { prepareQuestionDraft } from '../questionContentLogic';
import { validateImageUpload } from '../imageValidation';
import { useDialogFocusTrap } from '../dialogFocus';

const JEE_SYMBOLS = {
  Math: ['∫', '∑', '√', '±', 'π', '∞', '∈', '∉', '⊂', '∪', '∩', '∠', '∴', '∵', '≈', '≠', '≤', '≥', '½', '¼', 'x²', 'x³'],
  Physics: ['α', 'β', 'γ', 'θ', 'λ', 'μ', 'ω', 'Ω', 'Δ', 'Φ', 'ε', 'ρ', 'τ', '°', 'ħ', '→', '↑', '↓'],
  Chemistry: ['⇌', '⇄', '↑', '↓', '°C', '∆H', '∆S', '∆G', 'E°']
};

const QuestionEditor = ({ question, onSave, onCancel, existingQuestions }) => {
  const [editedQ, setEditedQ] = useState({
    ...question,
    options: question.options || ['', '', '', ''],
    optionImageUrls: question.optionImageUrls || [null, null, null, null],
  });
  
  const [focusedField, setFocusedField] = useState('text'); // 'text' or 0,1,2,3
  const [uploading, setUploading] = useState(false);
  const [activeCategory, setActiveCategory] = useState('All');
  const uploadedPathsRef = useRef([]);
  
  const textRef = useRef(null);
  const opt0Ref = useRef(null);
  const opt1Ref = useRef(null);
  const opt2Ref = useRef(null);
  const opt3Ref = useRef(null);

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

  const handleTextChange = (field, value) => {
    if (field === 'text') {
      setEditedQ({ ...editedQ, text: value });
    } else {
      const newOptions = [...editedQ.options];
      newOptions[field] = value;
      setEditedQ({ ...editedQ, options: newOptions });
    }
  };

  const insertSymbol = (symbol) => {
    const textarea = textRefs[focusedField].current;
    if (!textarea) return;

    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const currentValue = focusedField === 'text' ? editedQ.text : editedQ.options[focusedField];
    
    const newValue = currentValue.substring(0, start) + symbol + currentValue.substring(end);
    
    handleTextChange(focusedField, newValue);
    
    // Set cursor position after inserted symbol (needs a slight timeout to let React render)
    setTimeout(() => {
      textarea.selectionStart = textarea.selectionEnd = start + symbol.length;
      textarea.focus();
    }, 0);
  };

  const handleImageUpload = async (e, field) => {
    const file = e.target.files[0];
    if (!file) return;

    const validation = await validateImageUpload(file);
    if (!validation.valid) {
      await customAlert(validation.error);
      e.target.value = null;
      return;
    }

    setUploading(true);
    try {
      const reader = new FileReader();
      reader.onload = (event) => {
        const img = new Image();
        img.onload = () => {
          if (!img.width || !img.height || img.width > 12000 || img.height > 12000 || img.width * img.height > 40000000) {
            setUploading(false);
            customAlert('The image dimensions are too large to process safely. Use an image under 40 megapixels.');
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
            setUploading(false);
            customAlert('This browser could not process the image. Try another supported image.');
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
              await customAlert('Image upload failed. Please try again.');
            } finally {
              setUploading(false);
            }
          }, 'image/jpeg', 0.7);
        };
        img.onerror = async () => {
          setUploading(false);
          await customAlert('The selected file is not a readable image.');
        };
        img.src = event.target.result;
      };
      reader.onerror = async () => {
        setUploading(false);
        await customAlert('The selected image could not be read.');
      };
      reader.readAsDataURL(file);
    } catch (err) {
      console.error("Image processing failed", err);
      customAlert("Failed to process image.");
      setUploading(false);
    }
    e.target.value = null; // reset input
  };

  const validateAndSave = async () => {
    const { question: normalizedQuestion, errors } = prepareQuestionDraft(editedQ, existingQuestions);
    if (errors.length > 0) {
      await customAlert(errors.join('\n'));
      return;
    }

    const referencedPaths = new Set([
      normalizedQuestion.questionImageUrl,
      ...(normalizedQuestion.optionImageUrls || [])
    ].filter(Boolean));
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
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby="question-editor-title"
      tabIndex={-1}
      onKeyDown={handleDialogKeyDown}
      style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9999 }}
    >
      <div style={{ backgroundColor: 'var(--panel-bg)', padding: '30px', borderRadius: '12px', width: '90%', maxWidth: '800px', maxHeight: '90vh', overflowY: 'auto', boxShadow: '0 20px 25px -5px rgba(0, 0, 0, 0.2)' }}>
        <h2 id="question-editor-title" style={{ color: 'var(--text-main)', marginTop: 0, display: 'flex', justifyContent: 'space-between' }}>
          Edit Question
          <button
            type="button"
            onClick={cancelEditor}
            aria-label="Close question editor"
            style={{ background: 'none', border: 'none', fontSize: '1.5rem', cursor: 'pointer', color: 'var(--text-muted)' }}
          >
            &times;
          </button>
        </h2>

        {/* Math Keyboard */}
        <div style={{ backgroundColor: 'var(--bg-color)', padding: '15px', borderRadius: '8px', marginBottom: '20px', border: '1px solid var(--border-color)' }}>
          <div style={{ display: 'flex', gap: '10px', marginBottom: '10px' }}>
            {['All', ...Object.keys(JEE_SYMBOLS)].map(cat => (
              <button 
                key={cat} 
                type="button"
                onClick={() => setActiveCategory(cat)}
                style={{ padding: '5px 12px', borderRadius: '20px', border: 'none', backgroundColor: activeCategory === cat ? 'var(--primary)' : 'rgba(0,0,0,0.05)', color: activeCategory === cat ? 'white' : 'var(--text-main)', cursor: 'pointer', fontWeight: 'bold' }}
              >
                {cat}
              </button>
            ))}
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
            {getSymbolsToDisplay().map((sym, idx) => (
              <button 
                key={`${sym}-${idx}`} 
                type="button"
                onClick={() => insertSymbol(sym)}
                style={{ width: '35px', height: '35px', fontSize: '1.1rem', backgroundColor: 'white', border: '1px solid #e2e8f0', borderRadius: '4px', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: '0 1px 2px rgba(0,0,0,0.05)' }}
                title={`Insert ${sym}`}
                onMouseOver={e => e.currentTarget.style.backgroundColor = '#f1f5f9'}
                onMouseOut={e => e.currentTarget.style.backgroundColor = 'white'}
              >
                {sym}
              </button>
            ))}
          </div>
          <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginTop: '8px', fontStyle: 'italic' }}>
            Click a symbol to insert it into the currently active text box.
          </div>
        </div>

        {/* Type & Subject Selection */}
        <div className="responsive-two-column-grid" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '20px', marginBottom: '20px', padding: '15px', backgroundColor: 'rgba(37, 99, 235, 0.03)', borderRadius: '8px', border: '1px solid var(--border-color)' }}>
          <div>
            <label style={{ display: 'block', fontWeight: 'bold', marginBottom: '6px', color: 'var(--text-main)' }}>Question Type</label>
            <select
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
              style={{ width: '100%', padding: '10px', borderRadius: '6px', border: '1px solid var(--border-color)', fontWeight: 'bold', backgroundColor: 'white' }}
            >
              <option value="MCQ">Multiple Choice Question (MCQ)</option>
              <option value="NUMERICAL">Numerical Answer Type (NAT)</option>
            </select>
          </div>
          <div>
            <label style={{ display: 'block', fontWeight: 'bold', marginBottom: '6px', color: 'var(--text-main)' }}>Subject</label>
            <select
              value={editedQ.subject || 'Physics'}
              onChange={(e) => setEditedQ({ ...editedQ, subject: e.target.value })}
              style={{ width: '100%', padding: '10px', borderRadius: '6px', border: '1px solid var(--border-color)', fontWeight: 'bold', backgroundColor: 'white' }}
            >
              <option value="Physics">Physics</option>
              <option value="Chemistry">Chemistry</option>
              <option value="Mathematics">Mathematics</option>
            </select>
          </div>
        </div>

        {/* Question Text & Image */}
        <div style={{ marginBottom: '20px' }}>
          <label style={{ display: 'block', fontWeight: 'bold', marginBottom: '8px' }}>Question Prompt</label>
          <textarea 
            ref={textRefs['text']}
            value={editedQ.text} 
            onChange={(e) => handleTextChange('text', e.target.value)}
            onFocus={() => setFocusedField('text')}
            style={{ width: '100%', height: '80px', padding: '10px', borderRadius: '6px', border: '1px solid var(--border-color)', resize: 'vertical' }}
          />
          {editedQ.text && (
            <div style={{ marginTop: '6px', padding: '8px 12px', backgroundColor: 'rgba(37, 99, 235, 0.04)', borderRadius: '6px', border: '1px solid rgba(37, 99, 235, 0.15)', fontSize: '0.95rem' }}>
              <span style={{ fontSize: '0.72rem', fontWeight: 'bold', color: 'var(--primary)', display: 'block', marginBottom: '3px' }}>📐 LIVE MATH PREVIEW:</span>
              <MathRenderer text={editedQ.text} />
            </div>
          )}
          <div style={{ marginTop: '8px', display: 'flex', alignItems: 'center', gap: '10px' }}>
            <input type="file" id="q-img-upload" accept="image/jpeg,image/png,image/webp" onChange={(e) => handleImageUpload(e, 'question')} style={{ display: 'none' }} disabled={uploading} />
            <label htmlFor="q-img-upload" className="btn-outline" style={{ padding: '6px 12px', fontSize: '0.85rem', cursor: 'pointer', display: 'inline-block' }}>
              🖼️ {uploading ? 'Uploading...' : 'Upload Question Image'}
            </label>
            {editedQ.questionImageUrl && (
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                <StorageImage src={editedQ.questionImageUrl} alt="Question" style={{ height: '40px', borderRadius: '4px', border: '1px solid var(--border-color)' }} />
                <button type="button" onClick={() => setEditedQ({...editedQ, questionImageUrl: null})} style={{ color: 'var(--danger)', background: 'none', border: 'none', cursor: 'pointer' }}>Remove</button>
              </div>
            )}
          </div>
        </div>

        {/* Options / Numerical Answer */}
        {editedQ.type === 'NUMERICAL' ? (
          <div style={{ padding: '20px', backgroundColor: 'rgba(245, 158, 11, 0.05)', borderRadius: '8px', border: '2px dashed var(--warning)', marginBottom: '20px' }}>
            <h4 style={{ margin: '0 0 10px', color: '#b45309', display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span>🔢</span> Numerical Answer Type (NAT)
            </h4>
            <p style={{ fontSize: '0.9rem', color: 'var(--text-muted)', marginBottom: '15px' }}>
              This question does not have multiple choice options. The student will enter a numerical value directly into an input box or keypad.
            </p>
            <div>
              <label style={{ display: 'block', fontWeight: 'bold', marginBottom: '8px', color: 'var(--text-main)' }}>Exact Correct Answer (Integer or Decimal):</label>
              <input
                type="number"
                step="any"
                placeholder="e.g. 250, 9.8, -3.14"
                value={editedQ.correctAnswer !== null && editedQ.correctAnswer !== undefined ? editedQ.correctAnswer : ''}
                onChange={(e) => setEditedQ({ ...editedQ, correctAnswer: e.target.value === '' ? '' : Number(e.target.value) })}
                style={{ width: '100%', maxWidth: '300px', padding: '12px 15px', fontSize: '1.1rem', fontWeight: 'bold', borderRadius: '6px', border: '2px solid var(--warning)', outline: 'none', backgroundColor: 'white' }}
              />
            </div>
          </div>
        ) : (
          <div className="responsive-two-column-grid" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '20px', marginBottom: '20px' }}>
            {[0, 1, 2, 3].map(i => (
              <div key={i} style={{ backgroundColor: 'rgba(0,0,0,0.02)', padding: '15px', borderRadius: '8px', border: '1px solid var(--border-color)' }}>
                <label style={{ display: 'block', fontWeight: 'bold', marginBottom: '8px' }}>Option {String.fromCharCode(65 + i)}</label>
                <textarea 
                  ref={textRefs[i]}
                  value={editedQ.options[i]} 
                  onChange={(e) => handleTextChange(i, e.target.value)}
                  onFocus={() => setFocusedField(i)}
                  style={{ width: '100%', height: '50px', padding: '10px', borderRadius: '6px', border: '1px solid var(--border-color)', resize: 'vertical' }}
                />
                {editedQ.options[i] && (
                  <div style={{ marginTop: '4px', padding: '4px 8px', backgroundColor: 'rgba(37, 99, 235, 0.04)', borderRadius: '4px', border: '1px solid rgba(37, 99, 235, 0.1)', fontSize: '0.9rem' }}>
                    <MathRenderer text={editedQ.options[i]} />
                  </div>
                )}
                <div style={{ marginTop: '8px', display: 'flex', alignItems: 'center', gap: '10px' }}>
                  <input type="file" id={`opt-img-${i}`} accept="image/jpeg,image/png,image/webp" onChange={(e) => handleImageUpload(e, i)} style={{ display: 'none' }} disabled={uploading} />
                  <label htmlFor={`opt-img-${i}`} style={{ fontSize: '0.85rem', cursor: 'pointer', color: 'var(--primary)', fontWeight: 'bold' }}>
                    {uploading ? '...' : '+ Add Image'}
                  </label>
                  {editedQ.optionImageUrls[i] && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
                      <StorageImage src={editedQ.optionImageUrls[i]} alt={`Option ${i}`} style={{ height: '30px', borderRadius: '4px' }} />
                      <button type="button" onClick={() => {
                        const newArr = [...editedQ.optionImageUrls];
                        newArr[i] = null;
                        setEditedQ({...editedQ, optionImageUrls: newArr});
                      }} style={{ color: 'var(--danger)', background: 'none', border: 'none', cursor: 'pointer', fontSize: '0.8rem' }}>✖</button>
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Correct Answer & Save */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '30px', paddingTop: '20px', borderTop: '1px solid var(--border-color)' }}>
          <div>
            {editedQ.type !== 'NUMERICAL' && (
              <>
                <label style={{ fontWeight: 'bold', marginRight: '10px' }}>Correct Answer:</label>
                <select 
                  value={editedQ.correctAnswer} 
                  onChange={(e) => setEditedQ({...editedQ, correctAnswer: parseInt(e.target.value)})}
                  style={{ padding: '8px', borderRadius: '6px', border: '1px solid var(--border-color)', fontSize: '1rem' }}
                >
                  {[0, 1, 2, 3].map(i => (
                    <option key={i} value={i}>Option {String.fromCharCode(65 + i)}</option>
                  ))}
                </select>
              </>
            )}
          </div>
          <div style={{ display: 'flex', gap: '10px' }}>
            <button type="button" className="btn-outline" onClick={cancelEditor} style={{ padding: '10px 20px' }}>Cancel</button>
            <button type="button" className="btn-primary" onClick={validateAndSave} style={{ padding: '10px 20px' }} disabled={uploading}>Save Changes</button>
          </div>
        </div>
      </div>
    </div>
  );

  return ReactDOM.createPortal(modalContent, document.body);
};

export default QuestionEditor;
