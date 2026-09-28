import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import Result from '../../src/components/Result';

const scorecard = (overrides = {}) => ({
  totalScore: 10, maxScore: 25, correct: 3, incorrect: 2, unattempted: 1, subjectScores: { Physics: 10 }, ...overrides
});

describe('Result', () => {
  it('shows the partially correct count when partial marks were awarded', () => {
    render(<Result results={scorecard({ partial: 1 })} onBackToDashboard={vi.fn()} />);
    expect(screen.getByText('Partially Correct')).toBeTruthy();
    expect(screen.getByText('Partially Correct').nextElementSibling.textContent).toBe('1');
  });

  it('keeps the three-card layout when nothing was partially correct', () => {
    render(<Result results={scorecard({ partial: 0 })} onBackToDashboard={vi.fn()} />);
    expect(screen.queryByText('Partially Correct')).toBeNull();
    render(<Result results={scorecard()} onBackToDashboard={vi.fn()} />);
    expect(screen.queryByText('Partially Correct')).toBeNull();
  });
});
