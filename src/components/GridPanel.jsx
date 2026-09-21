import { getStatusGlyph, getStatusLabel } from '../accessibilityLogic';

export { getStatusGlyph, getStatusLabel };

const GridPanel = ({ 
  totalQuestions, 
  questionStatuses, 
  currentQuestionIndex, 
  setCurrentQuestionIndex 
}) => {
  
  // Count statuses
  const counts = {
    notVisited: 0,
    notAnswered: 0,
    answered: 0,
    marked: 0,
    answeredMarked: 0
  };

  questionStatuses.forEach(status => {
    if (status === 'NOT_VISITED') counts.notVisited++;
    else if (status === 'NOT_ANSWERED') counts.notAnswered++;
    else if (status === 'ANSWERED') counts.answered++;
    else if (status === 'MARKED') counts.marked++;
    else if (status === 'ANSWERED_MARKED') counts.answeredMarked++;
  });

  const getStatusClass = (status) => {
    switch(status) {
      case 'NOT_VISITED': return 'status-not-visited';
      case 'NOT_ANSWERED': return 'status-not-answered';
      case 'ANSWERED': return 'status-answered';
      case 'MARKED': return 'status-marked';
      case 'ANSWERED_MARKED': return 'status-answered-marked';
      default: return 'status-not-visited';
    }
  };

  const handleKeyDown = (e, idx) => {
    let nextIdx = null;
    if (e.key === 'ArrowRight') {
      nextIdx = Math.min(idx + 1, totalQuestions - 1);
    } else if (e.key === 'ArrowLeft') {
      nextIdx = Math.max(idx - 1, 0);
    } else if (e.key === 'ArrowDown') {
      nextIdx = Math.min(idx + 5, totalQuestions - 1);
    } else if (e.key === 'ArrowUp') {
      nextIdx = Math.max(idx - 5, 0);
    } else if (e.key === 'Home') {
      nextIdx = 0;
    } else if (e.key === 'End') {
      nextIdx = totalQuestions - 1;
    }

    if (nextIdx !== null && nextIdx !== idx) {
      e.preventDefault();
      setCurrentQuestionIndex(nextIdx);
      const nextBtn = document.getElementById(`q-palette-btn-${nextIdx}`);
      nextBtn?.focus();
    }
  };

  return (
    <aside className="exam-grid-panel" aria-label="Question navigator" style={{ width: '30%', backgroundColor: 'var(--bg-color)', display: 'flex', flexDirection: 'column', height: '100%', overflowY: 'auto' }}>
      {/* Legend */}
      <div style={{ padding: '15px', borderBottom: '1px solid var(--border-color)', backgroundColor: 'white' }}>
        <h4 style={{ marginBottom: '15px', fontSize: '1rem', fontWeight: 'bold' }}>Status Legend</h4>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px', fontSize: '0.85rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <div className="status-not-visited" style={{ width: '25px', height: '25px', display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: '4px' }}>{counts.notVisited}</div>
            <span><span aria-hidden="true" style={{ fontWeight: 'bold' }}>·</span> Not Visited</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <div className="status-not-answered" style={{ width: '25px', height: '25px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{counts.notAnswered}</div>
            <span><span aria-hidden="true" style={{ fontWeight: 'bold' }}>—</span> Not Answered</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <div className="status-answered" style={{ width: '25px', height: '25px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{counts.answered}</div>
            <span><span aria-hidden="true" style={{ fontWeight: 'bold' }}>✓</span> Answered</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <div className="status-marked" style={{ width: '25px', height: '25px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{counts.marked}</div>
            <span><span aria-hidden="true" style={{ fontWeight: 'bold' }}>⚑</span> Marked for Review</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', gridColumn: 'span 2' }}>
            <div className="status-answered-marked" style={{ width: '25px', height: '25px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{counts.answeredMarked}</div>
            <span><span aria-hidden="true" style={{ fontWeight: 'bold' }}>✓⚑</span> Answered & Marked</span>
          </div>
        </div>
      </div>

      {/* Grid */}
      <div style={{ padding: '20px', backgroundColor: 'var(--bg-color)' }}>
        <h4 style={{ marginBottom: '15px', color: 'var(--text-main)', fontWeight: 'bold' }}>Choose a Question</h4>
        <div
          role="region"
          aria-label="Question palette"
          style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(44px, 1fr))', gap: '10px' }}
        >
          {Array.from({ length: totalQuestions }).map((_, idx) => {
            const status = questionStatuses[idx] || 'NOT_VISITED';
            const isActive = idx === currentQuestionIndex;
            const glyph = getStatusGlyph(status);
            return (
              <button
                key={idx}
                id={`q-palette-btn-${idx}`}
                className={getStatusClass(status)}
                aria-label={`Question ${idx + 1}, ${getStatusLabel(status)}${isActive ? ', current question' : ''}`}
                aria-current={isActive ? 'step' : undefined}
                onClick={() => setCurrentQuestionIndex(idx)}
                onKeyDown={(e) => handleKeyDown(e, idx)}
                style={{
                  width: '100%',
                  minHeight: '44px',
                  aspectRatio: '1',
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  justifyContent: 'center',
                  padding: '2px',
                  fontSize: '0.88rem',
                  fontWeight: 'bold',
                  border: isActive ? '2px solid black' : '1px solid var(--border-color)',
                  boxShadow: isActive ? '0 0 0 2px rgba(37,99,235,0.3)' : 'none',
                  cursor: 'pointer',
                  position: 'relative'
                }}
              >
                <span>{idx + 1}</span>
                {glyph !== '·' && (
                  <span aria-hidden="true" style={{ fontSize: '0.65rem', lineHeight: 1, marginTop: '1px' }}>
                    {glyph}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>
    </aside>
  );
};

export default GridPanel;
