import { memo } from 'react';
import { getStatusGlyph, getStatusLabel } from '../accessibilityLogic';
import { cn } from './ui';

export { getStatusGlyph, getStatusLabel };

/**
 * @param {{
 *   totalQuestions: number,
 *   questionStatuses: import('../types').ResponseStatus[],
 *   currentQuestionIndex: number,
 *   setCurrentQuestionIndex: (index: number) => void
 * }} props
 */
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

  /** @param {import('../types').ResponseStatus} status */
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

  /**
   * @param {import('react').KeyboardEvent<HTMLButtonElement>} e
   * @param {number} idx
   */
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

  const legendChip = 'flex size-7 shrink-0 items-center justify-center rounded-md text-xs font-bold tabular-nums';
  const legendItem = 'flex items-center gap-2 rounded-lg px-1.5 py-1 text-slate-700';
  const legendGlyph = 'inline-block w-5 text-center font-bold text-slate-500';

  return (
    <aside className="exam-grid-panel" aria-label="Question navigator" style={{ width: '30%', display: 'flex', flexDirection: 'column', height: '100%', overflowY: 'auto' }}>
      <div className="flex flex-1 flex-col bg-slate-50">
        {/* Legend */}
        <div className="border-b border-slate-200 bg-white p-4">
          <h4 className="mb-3 text-sm font-semibold text-slate-900">Status Legend</h4>
          <div className="grid grid-cols-2 gap-x-2 gap-y-1.5 text-xs font-medium">
            <div className={legendItem}>
              <div className={cn('status-not-visited', legendChip)}>{counts.notVisited}</div>
              <span><span aria-hidden="true" className={legendGlyph}>·</span> Not Visited</span>
            </div>
            <div className={legendItem}>
              <div className={cn('status-not-answered', legendChip)}>{counts.notAnswered}</div>
              <span><span aria-hidden="true" className={legendGlyph}>—</span> Not Answered</span>
            </div>
            <div className={legendItem}>
              <div className={cn('status-answered', legendChip)}>{counts.answered}</div>
              <span><span aria-hidden="true" className={legendGlyph}>✓</span> Answered</span>
            </div>
            <div className={legendItem}>
              <div className={cn('status-marked', legendChip)}>{counts.marked}</div>
              <span><span aria-hidden="true" className={legendGlyph}>⚑</span> Marked for Review</span>
            </div>
            <div className={cn(legendItem, 'col-span-2')}>
              <div className={cn('status-answered-marked', legendChip)}>{counts.answeredMarked}</div>
              <span><span aria-hidden="true" className={legendGlyph}>✓⚑</span> Answered & Marked</span>
            </div>
          </div>
        </div>

        {/* Grid */}
        <div className="flex-1 p-4">
          <h4 className="mb-3 flex items-center justify-between text-sm font-semibold text-slate-900">
            <span>Choose a Question</span>
            <span className="text-xs font-medium text-slate-500 tabular-nums">{totalQuestions} total</span>
          </h4>
          <div
            role="region"
            aria-label="Question palette"
            className="grid grid-cols-[repeat(auto-fill,minmax(44px,1fr))] gap-2.5"
          >
            {Array.from({ length: totalQuestions }).map((_, idx) => {
              const status = questionStatuses[idx] || 'NOT_VISITED';
              const isActive = idx === currentQuestionIndex;
              const glyph = getStatusGlyph(status);
              return (
                <button
                  key={idx}
                  id={`q-palette-btn-${idx}`}
                  className={cn(
                    getStatusClass(status),
                    'relative flex aspect-square min-h-11 w-full flex-col items-center justify-center rounded-lg p-0.5 text-sm font-bold tabular-nums shadow-sm transition hover:brightness-95',
                    isActive && 'exam-question-item-active ring-2 ring-brand-600 ring-offset-2 ring-offset-slate-50'
                  )}
                  aria-label={`Question ${idx + 1}, ${getStatusLabel(status)}${isActive ? ', current question' : ''}`}
                  aria-current={isActive ? 'step' : undefined}
                  onClick={() => setCurrentQuestionIndex(idx)}
                  onKeyDown={(e) => handleKeyDown(e, idx)}
                >
                  <span>{idx + 1}</span>
                  {glyph !== '·' && (
                    <span aria-hidden="true" className="mt-px text-[0.65rem] leading-none">
                      {glyph}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </aside>
  );
};

// Memoized: the session memoizes questionStatuses per subject and passes a
// stable navigation callback, so the palette re-renders only on real changes.
export default memo(GridPanel);
