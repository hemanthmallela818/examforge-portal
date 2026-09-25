import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import GridPanel from '../../src/components/GridPanel';

// delay: null keeps typing synchronous-fast while still dispatching full event sequences.
let user;
beforeEach(() => { user = userEvent.setup({ delay: null }); });

const statuses = ['ANSWERED', 'NOT_ANSWERED', 'MARKED', 'ANSWERED_MARKED', 'NOT_VISITED', 'ANSWERED', 'BOGUS'];

const renderGrid = (overrides = {}) => {
  const props = {
    totalQuestions: 8,
    questionStatuses: statuses,
    currentQuestionIndex: 1,
    setCurrentQuestionIndex: vi.fn(),
    ...overrides
  };
  render(<GridPanel {...props} />);
  return props;
};

const paletteButtons = () => within(screen.getByRole('region', { name: 'Question palette' })).getAllByRole('button');

describe('GridPanel', () => {
  it('renders one palette button per question with status classes', () => {
    renderGrid();
    const buttons = paletteButtons();
    expect(buttons).toHaveLength(8);
    expect(screen.getByText('8 total')).toBeTruthy();
    const expected = [
      'status-answered', 'status-not-answered', 'status-marked', 'status-answered-marked',
      'status-not-visited', 'status-answered', 'status-not-visited', 'status-not-visited'
    ];
    buttons.forEach((button, index) => expect(button.classList.contains(expected[index])).toBe(true));
  });

  it('labels each button with its status and marks the current question', () => {
    renderGrid();
    expect(screen.getByRole('button', { name: 'Question 1, answered' })).toBeTruthy();
    const current = screen.getByRole('button', { name: 'Question 2, not answered, current question' });
    expect(current.getAttribute('aria-current')).toBe('step');
    expect(current.classList.contains('exam-question-item-active')).toBe(true);
    expect(screen.getByRole('button', { name: 'Question 3, marked for review' }).getAttribute('aria-current')).toBeNull();
    expect(screen.getByRole('button', { name: 'Question 4, answered and marked for review' })).toBeTruthy();
    // Missing and unknown statuses fall back to "not visited".
    expect(screen.getByRole('button', { name: 'Question 7, not visited' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Question 8, not visited' })).toBeTruthy();
  });

  it('shows legend counts per status (unknown statuses are not counted)', () => {
    renderGrid();
    const legendCount = (label) => {
      const item = screen.getByText(label, { exact: false, selector: 'span' }).closest('div');
      return item.querySelector('div').textContent;
    };
    expect(legendCount('Not Visited')).toBe('1');
    expect(legendCount('Not Answered')).toBe('1');
    expect(legendCount('Answered & Marked')).toBe('1');
    expect(legendCount('Marked for Review')).toBe('1');
    const answeredChip = document.querySelector('.border-b .status-answered');
    expect(answeredChip.textContent).toBe('2');
  });

  it('navigates when a palette button is clicked', async () => {
    const props = renderGrid();
    await user.click(screen.getByRole('button', { name: 'Question 5, not visited' }));
    expect(props.setCurrentQuestionIndex).toHaveBeenCalledWith(4);
  });

  it('supports arrow, Home and End keys and moves focus', () => {
    const props = renderGrid({ totalQuestions: 12, questionStatuses: [], currentQuestionIndex: 0 });
    const buttons = paletteButtons();
    fireEvent.keyDown(buttons[0], { key: 'ArrowRight' });
    expect(props.setCurrentQuestionIndex).toHaveBeenLastCalledWith(1);
    expect(document.activeElement).toBe(buttons[1]);
    fireEvent.keyDown(buttons[1], { key: 'ArrowDown' });
    expect(props.setCurrentQuestionIndex).toHaveBeenLastCalledWith(6);
    fireEvent.keyDown(buttons[6], { key: 'ArrowUp' });
    expect(props.setCurrentQuestionIndex).toHaveBeenLastCalledWith(1);
    fireEvent.keyDown(buttons[1], { key: 'End' });
    expect(props.setCurrentQuestionIndex).toHaveBeenLastCalledWith(11);
    fireEvent.keyDown(buttons[11], { key: 'ArrowDown' }); // clamped, no change
    fireEvent.keyDown(buttons[11], { key: 'Home' });
    expect(props.setCurrentQuestionIndex).toHaveBeenLastCalledWith(0);
    fireEvent.keyDown(buttons[0], { key: 'ArrowLeft' }); // already first
    fireEvent.keyDown(buttons[0], { key: 'x' });
    expect(props.setCurrentQuestionIndex).toHaveBeenCalledTimes(5);
  });
});
