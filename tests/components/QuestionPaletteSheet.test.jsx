import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

const { default: QuestionPaletteSheet } = await import('../../src/features/exam/QuestionPaletteSheet');
const { default: GridPanel } = await import('../../src/components/GridPanel');

const renderSheet = () => {
  const onClose = vi.fn();
  const setCurrentQuestionIndex = vi.fn();
  render(
    <QuestionPaletteSheet onClose={onClose} subject="Physics">
      <GridPanel
        totalQuestions={6}
        questionStatuses={['ANSWERED', 'NOT_ANSWERED', 'NOT_VISITED', 'NOT_VISITED', 'NOT_VISITED', 'NOT_VISITED']}
        currentQuestionIndex={0}
        setCurrentQuestionIndex={setCurrentQuestionIndex}
      />
    </QuestionPaletteSheet>
  );
  return { onClose, setCurrentQuestionIndex };
};

describe('QuestionPaletteSheet (U14)', () => {
  it('is a labelled modal dialog containing the question navigator', () => {
    renderSheet();
    const dialog = screen.getByRole('dialog', { name: 'Questions' });
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.querySelector('.exam-grid-panel')).not.toBeNull();
  });

  it('closes after a question is chosen, but not while arrowing through the palette', () => {
    const { onClose, setCurrentQuestionIndex } = renderSheet();
    fireEvent.keyDown(screen.getByRole('button', { name: /^Question 1,/ }), { key: 'ArrowRight' });
    expect(setCurrentQuestionIndex).toHaveBeenCalledWith(1);
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /^Question 4,/ }));
    expect(setCurrentQuestionIndex).toHaveBeenCalledWith(3);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes from the Close button, and Escape is not a close key (lockdown owns it)', () => {
    const { onClose } = renderSheet();
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
