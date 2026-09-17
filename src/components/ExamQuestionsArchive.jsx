import React, { useState } from 'react';
import MathRenderer from './MathRenderer';
import StorageImage from './StorageImage';

const ExamQuestionsArchive = ({ exam }) => {
  const [selectedSubject, setSelectedSubject] = useState('ALL');
  const [searchTerm, setSearchTerm] = useState('');
  const [copied, setCopied] = useState(false);

  if (!exam || !exam.questionsData || !exam.questionsData.questions) {
    return null;
  }

  const { subjects, questions } = exam.questionsData;

  // Flatten all questions with their subject
  let allQuestions = [];
  if (subjects && Array.isArray(subjects)) {
    subjects.forEach(sub => {
      const subQs = questions[sub] || [];
      subQs.forEach((q, idx) => {
        allQuestions.push({
          ...q,
          subject: sub,
          displayNumber: idx + 1
        });
      });
    });
  } else {
    // Fallback if subjects array is not structured standardly
    Object.keys(questions).forEach(sub => {
      const subQs = questions[sub] || [];
      subQs.forEach((q, idx) => {
        allQuestions.push({
          ...q,
          subject: sub,
          displayNumber: idx + 1
        });
      });
    });
  }

  // Filter by subject and search term
  const filteredQuestions = allQuestions.filter(q => {
    const matchesSubject = selectedSubject === 'ALL' || q.subject === selectedSubject;
    const matchesSearch = !searchTerm || 
      (q.text && q.text.toLowerCase().includes(searchTerm.toLowerCase())) ||
      (q.options && q.options.some(opt => opt && opt.toLowerCase().includes(searchTerm.toLowerCase())));
    return matchesSubject && matchesSearch;
  });

  const handleCopyAsText = () => {
    let textOutput = `=== ${exam.title} - Question Archive ===\n\n`;
    allQuestions.forEach((q, index) => {
      const isNumerical = (q.type || '').toUpperCase() === 'NUMERICAL' || (q.type || '').toUpperCase() === 'NAT' || !q.options || q.options.length === 0;
      textOutput += `Q${index + 1} [${q.subject}] (${isNumerical ? 'NUMERICAL' : 'MCQ'}): ${q.text || '(Image Question)'}\n`;
      if (isNumerical) {
        textOutput += `   [NUMERICAL ANSWER]: ${q.correctAnswer}\n`;
      } else if (q.options && Array.isArray(q.options)) {
        q.options.forEach((opt, optIdx) => {
          const letter = String.fromCharCode(65 + optIdx);
          const isCorrect = Number(q.correctAnswer) === optIdx;
          textOutput += `   ${letter}) ${opt || '(Image Option)'} ${isCorrect ? ' [CORRECT]' : ''}\n`;
        });
      }
      textOutput += '\n';
    });

    navigator.clipboard.writeText(textOutput).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 3000);
    });
  };

  return (
    <div className="animate-fade-in" style={{ backgroundColor: 'var(--panel-bg)', padding: '30px', borderRadius: '12px', boxShadow: '0 4px 6px rgba(0,0,0,0.02)', border: '1px solid var(--border-color)', marginTop: '24px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '15px', marginBottom: '20px', paddingBottom: '15px', borderBottom: '1px solid var(--border-color)' }}>
        <div>
          <h3 style={{ color: 'var(--text-main)', margin: 0, fontSize: '1.5rem', display: 'flex', alignItems: 'center', gap: '10px' }}>
            <span>📄</span> Exam Question Paper Archive
          </h3>
          <p style={{ color: 'var(--text-muted)', margin: '5px 0 0', fontSize: '0.9rem' }}>
            Reference of all {allQuestions.length} questions included in this exam session for auditing and verification.
          </p>
        </div>

        <div style={{ display: 'flex', gap: '10px' }}>
          <button 
            onClick={handleCopyAsText} 
            className="btn-outline"
            style={{ padding: '8px 16px', borderRadius: '6px', fontSize: '0.9rem', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '6px', borderColor: copied ? 'var(--success)' : 'var(--border-color)', color: copied ? 'var(--success)' : 'var(--text-main)', fontWeight: 'bold' }}
          >
            {copied ? '✅ Copied to Clipboard!' : '📋 Copy Question Paper'}
          </button>
        </div>
      </div>

      {/* Subject Tabs and Search */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '15px', marginBottom: '25px' }}>
        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
          <button
            onClick={() => setSelectedSubject('ALL')}
            style={{
              padding: '6px 14px',
              borderRadius: '20px',
              border: 'none',
              backgroundColor: selectedSubject === 'ALL' ? 'var(--primary)' : 'rgba(0,0,0,0.05)',
              color: selectedSubject === 'ALL' ? 'white' : 'var(--text-main)',
              fontWeight: 'bold',
              cursor: 'pointer',
              fontSize: '0.85rem',
              transition: 'all 0.2s'
            }}
          >
            All Subjects ({allQuestions.length})
          </button>
          {subjects && subjects.map(sub => {
            const count = (questions[sub] || []).length;
            return (
              <button
                key={sub}
                onClick={() => setSelectedSubject(sub)}
                style={{
                  padding: '6px 14px',
                  borderRadius: '20px',
                  border: 'none',
                  backgroundColor: selectedSubject === sub ? 'var(--primary)' : 'rgba(0,0,0,0.05)',
                  color: selectedSubject === sub ? 'white' : 'var(--text-main)',
                  fontWeight: 'bold',
                  cursor: 'pointer',
                  fontSize: '0.85rem',
                  transition: 'all 0.2s'
                }}
              >
                {sub} ({count})
              </button>
            );
          })}
        </div>

        <input
          type="text"
          placeholder="🔍 Search question prompt or option..."
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
          style={{
            padding: '8px 14px',
            borderRadius: '20px',
            border: '1px solid var(--border-color)',
            backgroundColor: 'var(--bg-color)',
            color: 'var(--text-main)',
            fontSize: '0.9rem',
            width: '260px',
            outline: 'none'
          }}
        />
      </div>

      {/* Questions List */}
      {filteredQuestions.length === 0 ? (
        <div style={{ padding: '40px', textAlign: 'center', color: 'var(--text-muted)', backgroundColor: 'var(--bg-color)', borderRadius: '8px', border: '1px dashed var(--border-color)' }}>
          <p style={{ margin: 0 }}>No questions found matching your filter criteria.</p>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '16px', maxHeight: '700px', overflowY: 'auto', paddingRight: '5px' }}>
          {filteredQuestions.map((q, idx) => (
            <div 
              key={`${q.subject}-${idx}-${q.id || 'noid'}`}
              style={{
                backgroundColor: 'var(--bg-color)',
                padding: '20px',
                borderRadius: '8px',
                border: '1px solid var(--border-color)',
                display: 'flex',
                flexDirection: 'column',
                gap: '12px'
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
                  <span style={{ 
                    backgroundColor: 'rgba(37, 99, 235, 0.1)', 
                    color: 'var(--primary)', 
                    padding: '4px 10px', 
                    borderRadius: '4px', 
                    fontWeight: 'bold', 
                    fontSize: '0.8rem',
                    textTransform: 'uppercase',
                    letterSpacing: '0.5px'
                  }}>
                    {q.subject}
                  </span>
                  <span style={{ 
                    backgroundColor: q.type === 'NUMERICAL' ? '#fef3c7' : 'rgba(34, 197, 94, 0.1)', 
                    color: q.type === 'NUMERICAL' ? '#d97706' : 'var(--success)', 
                    padding: '4px 10px', 
                    borderRadius: '4px', 
                    fontWeight: 'bold', 
                    fontSize: '0.75rem',
                    textTransform: 'uppercase',
                    letterSpacing: '0.5px'
                  }}>
                    {q.type === 'NUMERICAL' ? 'NUMERICAL VALUE TYPE' : 'MCQ'}
                  </span>
                  <span style={{ fontWeight: 'bold', color: 'var(--text-main)', fontSize: '1.05rem' }}>
                    Question #{q.displayNumber}
                  </span>
                </div>
              </div>

              <div style={{ fontSize: '1.05rem', color: 'var(--text-main)', lineHeight: '1.5', fontWeight: '500' }}>
                <MathRenderer text={q.text} />
              </div>

              {q.questionImageUrl && (
                <div style={{ marginTop: '5px' }}>
                  <StorageImage 
                    src={q.questionImageUrl} 
                    alt="Question Diagram" 
                    style={{ maxHeight: '200px', maxWidth: '100%', borderRadius: '6px', border: '1px solid var(--border-color)' }} 
                  />
                </div>
              )}

              {/* Options / Numerical Answer */}
              {q.type === 'NUMERICAL' || !q.options || q.options.length === 0 ? (
                <div style={{
                  padding: '14px 18px',
                  borderRadius: '6px',
                  border: '2px solid #f59e0b',
                  backgroundColor: '#fffbeb',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '12px',
                  marginTop: '10px',
                  fontWeight: 'bold',
                  color: '#b45309',
                  boxShadow: '0 2px 4px rgba(0,0,0,0.03)'
                }}>
                  <span style={{ fontSize: '1.2rem' }}>🔢</span>
                  <span>Correct Numerical Answer:</span>
                  <span style={{ fontSize: '1.3rem', color: '#92400e', backgroundColor: '#fde68a', padding: '2px 10px', borderRadius: '4px' }}>{q.correctAnswer}</span>
                </div>
              ) : (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '10px', marginTop: '8px' }}>
                  {q.options && q.options.map((opt, optIdx) => {
                  const isCorrect = Number(q.correctAnswer) === optIdx;
                  const optImg = q.optionImageUrls && q.optionImageUrls[optIdx];
                  const letter = String.fromCharCode(65 + optIdx);

                  return (
                    <div 
                      key={optIdx} 
                      style={{
                        padding: '12px 15px',
                        borderRadius: '6px',
                        border: isCorrect ? '2px solid var(--success)' : '1px solid var(--border-color)',
                        backgroundColor: isCorrect ? 'rgba(16, 185, 129, 0.08)' : 'var(--panel-bg)',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        gap: '10px'
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', overflow: 'hidden' }}>
                        <span style={{ 
                          fontWeight: 'bold', 
                          color: isCorrect ? 'var(--success)' : 'var(--text-muted)',
                          minWidth: '22px'
                        }}>
                          {letter})
                        </span>
                        <span style={{ color: 'var(--text-main)' }}>
                          <MathRenderer text={opt || '(Image Option)'} />
                        </span>
                      </div>

                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                        {optImg && (
                          <StorageImage 
                            src={optImg} 
                            alt={`Option ${letter}`} 
                            style={{ height: '40px', borderRadius: '4px', border: '1px solid var(--border-color)' }} 
                          />
                        )}
                        {isCorrect && (
                          <span style={{ 
                            fontSize: '0.75rem', 
                            fontWeight: 'bold', 
                            color: 'white', 
                            backgroundColor: 'var(--success)', 
                            padding: '2px 8px', 
                            borderRadius: '10px' 
                          }}>
                            CORRECT
                          </span>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

export default ExamQuestionsArchive;
