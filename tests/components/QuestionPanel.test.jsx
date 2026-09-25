import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import QuestionPanel from '../../src/components/QuestionPanel';

// delay: null keeps typing synchronous-fast while still dispatching full event sequences.
let user;
beforeEach(() => { user = userEvent.setup({ delay: null }); });

const mcq = { id: 'q1', type: 'MCQ', text: 'Pick the second option', options: ['First', 'Second', 'Third', 'Fourth'] };
const numerical = { id: 'q2', type: 'NUMERICAL', text: 'Enter a value', options: [] };

const makeProps = (overrides = {}) => ({
  question: mcq,
  questionIndex: 0,
  selectedOption: null,
  setSelectedOption: vi.fn(),
  handleAction: vi.fn(),
  goNext: vi.fn(),
  goPrev: vi.fn(),
  submitExam: vi.fn(),
  isFirstQuestionOfExam: false,
  isLastQuestionOfExam: false,
  ...overrides
});

// The parent (App) owns the selected option; mirror that so controlled inputs behave realistically.
const Harness = ({ initial = null, onSelect, ...props }) => {
  const [selected, setSelected] = useState(initial);
  return (
    <QuestionPanel
      {...props}
      selectedOption={selected}
      setSelectedOption={(value) => { onSelect(value); setSelected(value); }}
    />
  );
};

describe('QuestionPanel multiple choice', () => {
  it('renders a heading, type badge and options as labelled radios', () => {
    render(<QuestionPanel {...makeProps({ questionIndex: 4 })} />);
    expect(screen.getByRole('heading', { name: 'Question 5' })).toBeTruthy();
    expect(screen.getByText('MULTIPLE CHOICE')).toBeTruthy();
    const group = screen.getByRole('radiogroup', { name: 'Pick the second option' });
    expect(group).toBeTruthy();
    const radios = screen.getAllByRole('radio');
    expect(radios).toHaveLength(4);
    expect(screen.getByRole('radio', { name: 'A. First' })).toBeTruthy();
    expect(screen.getByRole('radio', { name: 'B. Second' })).toBeTruthy();
    expect(screen.getByRole('radio', { name: 'D. Fourth' })).toBeTruthy();
    expect(radios.every(radio => radio.checked === false)).toBe(true);
    expect(screen.queryByLabelText('Your Numerical Answer:')).toBeNull();
  });

  it('reflects the selected option and reports a new selection by index', async () => {
    const props = makeProps({ selectedOption: 0 });
    render(<QuestionPanel {...props} />);
    expect(screen.getByRole('radio', { name: 'A. First' }).checked).toBe(true);
    await user.click(screen.getByRole('radio', { name: 'B. Second' }));
    expect(props.setSelectedOption).toHaveBeenCalledWith(1);
  });

  it('moves the selection with arrow keys and wraps around', () => {
    const props = makeProps({ selectedOption: 0 });
    render(<QuestionPanel {...props} />);
    fireEvent.keyDown(screen.getByRole('radio', { name: 'A. First' }), { key: 'ArrowUp' });
    expect(props.setSelectedOption).toHaveBeenLastCalledWith(3);
    fireEvent.keyDown(screen.getByRole('radio', { name: 'A. First' }), { key: 'ArrowDown' });
    expect(props.setSelectedOption).toHaveBeenLastCalledWith(1);
  });

  it('escapes markup in option text and renders delimited math with KaTeX', () => {
    const { unmount } = render(<QuestionPanel {...makeProps({ question: { ...mcq, options: ['<b>raw</b>', 'plain'] } })} />);
    expect(screen.getByRole('radio', { name: 'A. <b>raw</b>' })).toBeTruthy();
    expect(document.querySelector('.question-option-card b')).toBeNull();
    unmount();

    // jsdom cannot compute accessible names through KaTeX inline styles, so check the DOM directly.
    render(<QuestionPanel {...makeProps({ question: { ...mcq, options: ['$x^2$', 'y'] } })} />);
    const firstCard = screen.getAllByRole('radio')[0].closest('label');
    expect(firstCard.querySelector('.katex annotation').textContent).toBe('x^2');
  });

  it('disables every answer control when disabled', async () => {
    const props = makeProps({ disabled: true });
    render(<QuestionPanel {...props} />);
    expect(screen.getAllByRole('radio').every(radio => radio.disabled)).toBe(true);
    for (const name of ['Save & Next', 'Save & Mark for Review', 'Clear Response', 'Mark for Review & Next']) {
      expect(screen.getByRole('button', { name }).disabled).toBe(true);
    }
    fireEvent.keyDown(window, { key: 's', altKey: true });
    expect(props.handleAction).not.toHaveBeenCalled();
  });
});

describe('QuestionPanel actions', () => {
  it('calls handleAction for Save & Next, Save & Mark and Mark & Next', async () => {
    const props = makeProps({ selectedOption: 1 });
    render(<QuestionPanel {...props} />);
    await user.click(screen.getByRole('button', { name: 'Save & Next' }));
    await user.click(screen.getByRole('button', { name: 'Save & Mark for Review' }));
    await user.click(screen.getByRole('button', { name: 'Mark for Review & Next' }));
    expect(props.handleAction.mock.calls).toEqual([['SAVE_NEXT'], ['SAVE_MARK'], ['MARK_NEXT']]);
  });

  it('clears the response with Clear Response', async () => {
    const props = makeProps({ selectedOption: 2 });
    render(<QuestionPanel {...props} />);
    await user.click(screen.getByRole('button', { name: 'Clear Response' }));
    expect(props.setSelectedOption).toHaveBeenCalledWith(null);
    expect(props.handleAction).not.toHaveBeenCalled();
  });

  it('navigates with Back / Next and respects exam boundaries', async () => {
    const props = makeProps();
    const { rerender } = render(<QuestionPanel {...props} />);
    await user.click(screen.getByRole('button', { name: 'Back' }));
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(props.goPrev).toHaveBeenCalledTimes(1);
    expect(props.goNext).toHaveBeenCalledTimes(1);

    rerender(<QuestionPanel {...props} isFirstQuestionOfExam isLastQuestionOfExam />);
    expect(screen.getByRole('button', { name: 'Back' }).disabled).toBe(true);
    expect(screen.getByRole('button', { name: 'Next' }).disabled).toBe(true);
  });

  it('submits the exam via Submit Exam', async () => {
    const props = makeProps();
    render(<QuestionPanel {...props} />);
    await user.click(screen.getByRole('button', { name: 'Submit Exam' }));
    expect(props.submitExam).toHaveBeenCalledTimes(1);
  });

  it('supports keyboard shortcuts outside text inputs', () => {
    const props = makeProps();
    render(<QuestionPanel {...props} />);
    fireEvent.keyDown(window, { key: 's', altKey: true });
    fireEvent.keyDown(window, { key: 'Enter', ctrlKey: true });
    fireEvent.keyDown(window, { key: 'M', altKey: true });
    fireEvent.keyDown(window, { key: 'c', altKey: true });
    fireEvent.keyDown(window, { key: 'ArrowRight' });
    fireEvent.keyDown(window, { key: 'ArrowLeft' });
    expect(props.handleAction.mock.calls).toEqual([['SAVE_NEXT'], ['SAVE_NEXT'], ['SAVE_MARK']]);
    expect(props.setSelectedOption).toHaveBeenCalledWith(null);
    expect(props.goNext).toHaveBeenCalledTimes(1);
    expect(props.goPrev).toHaveBeenCalledTimes(1);
  });

  it('does not navigate past the first or last question with arrow keys', () => {
    const props = makeProps({ isFirstQuestionOfExam: true, isLastQuestionOfExam: true });
    render(<QuestionPanel {...props} />);
    fireEvent.keyDown(window, { key: 'ArrowRight' });
    fireEvent.keyDown(window, { key: 'ArrowLeft' });
    expect(props.goNext).not.toHaveBeenCalled();
    expect(props.goPrev).not.toHaveBeenCalled();
  });
});

describe('QuestionPanel numerical answers', () => {
  it('renders a labelled text input instead of radios', () => {
    render(<QuestionPanel {...makeProps({ question: numerical })} />);
    expect(screen.getByText('NUMERICAL VALUE TYPE')).toBeTruthy();
    expect(screen.queryAllByRole('radio')).toHaveLength(0);
    const input = screen.getByLabelText('Your Numerical Answer:');
    expect(input.getAttribute('inputmode')).toBe('decimal');
  });

  it('treats a question without options as numerical', () => {
    render(<QuestionPanel {...makeProps({ question: { id: 'q3', text: 'No options' } })} />);
    expect(screen.getByLabelText('Your Numerical Answer:')).toBeTruthy();
  });

  it('saves only complete decimal values while typing', async () => {
    const onSelect = vi.fn();
    render(<Harness {...makeProps({ question: numerical })} onSelect={onSelect} />);
    const input = screen.getByLabelText('Your Numerical Answer:');
    await user.type(input, '-.');
    expect(input.value).toBe('-.');
    expect(onSelect).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toContain('Finish entering the numerical value.');
    expect(input.getAttribute('aria-invalid')).toBe('true');

    await user.type(input, '25');
    expect(input.value).toBe('-.25');
    expect(onSelect.mock.calls).toEqual([['-.2'], ['-.25']]);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(input.getAttribute('aria-invalid')).toBe('false');
  });

  it('rejects scientific notation without replacing the last saved answer', async () => {
    const onSelect = vi.fn();
    render(<Harness {...makeProps({ question: numerical })} onSelect={onSelect} />);
    const input = screen.getByLabelText('Your Numerical Answer:');
    await user.type(input, '1e5');
    expect(onSelect.mock.calls).toEqual([['1']]);
    expect(screen.getByRole('alert').textContent).toContain('Scientific notation is not accepted.');
  });

  it('builds a value with the virtual keypad, toggles sign and backspaces', async () => {
    const onSelect = vi.fn();
    render(<Harness {...makeProps({ question: numerical })} onSelect={onSelect} />);
    const input = screen.getByLabelText('Your Numerical Answer:');
    const key = (name) => user.click(screen.getByRole('button', { name }));

    await key('1');
    await key('.');
    await key('.'); // a second decimal point is ignored
    await key('5');
    expect(input.value).toBe('1.5');
    expect(onSelect).toHaveBeenLastCalledWith('1.5');

    await key('-');
    expect(input.value).toBe('-1.5');
    expect(onSelect).toHaveBeenLastCalledWith('-1.5');
    await key('-');
    expect(input.value).toBe('1.5');

    await key('Backspace');
    expect(input.value).toBe('1.');
    await key('Backspace');
    expect(input.value).toBe('1');
    expect(onSelect).toHaveBeenLastCalledWith('1');

    await key('Clear All');
    expect(input.value).toBe('');
    expect(onSelect).toHaveBeenLastCalledWith(null);
  });

  it('blocks Save & Next and Submit while the draft is incomplete', async () => {
    const onSelect = vi.fn();
    const props = makeProps({ question: numerical });
    render(<Harness {...props} onSelect={onSelect} />);
    await user.click(screen.getByRole('button', { name: '-' }));
    await user.click(screen.getByRole('button', { name: 'Save & Next' }));
    await user.click(screen.getByRole('button', { name: 'Submit Exam' }));
    expect(props.handleAction).not.toHaveBeenCalled();
    expect(props.submitExam).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toContain('Finish entering the numerical value.');

    await user.click(screen.getByRole('button', { name: '7' }));
    await user.click(screen.getByRole('button', { name: 'Save & Next' }));
    expect(props.handleAction).toHaveBeenCalledWith('SAVE_NEXT');
    expect(onSelect).toHaveBeenLastCalledWith('-7');
  });

  it('shows the saved value and resets the draft when the question changes', () => {
    const props = makeProps({ question: numerical, selectedOption: '2.5' });
    const { rerender } = render(<QuestionPanel {...props} />);
    expect(screen.getByLabelText('Your Numerical Answer:').value).toBe('2.5');
    rerender(<QuestionPanel {...props} question={{ ...numerical, id: 'other' }} selectedOption={null} />);
    expect(screen.getByLabelText('Your Numerical Answer:').value).toBe('');
  });

  it('ignores arrow-key navigation while typing in the numerical input', () => {
    const props = makeProps({ question: numerical });
    render(<QuestionPanel {...props} />);
    const input = screen.getByLabelText('Your Numerical Answer:');
    input.focus();
    fireEvent.keyDown(input, { key: 'ArrowRight' });
    fireEvent.keyDown(input, { key: 'ArrowLeft' });
    expect(props.goNext).not.toHaveBeenCalled();
    expect(props.goPrev).not.toHaveBeenCalled();
  });

  it('disables the input and keypad when disabled', () => {
    render(<QuestionPanel {...makeProps({ question: numerical, disabled: true })} />);
    expect(screen.getByLabelText('Your Numerical Answer:').disabled).toBe(true);
    expect(screen.getByRole('button', { name: '5' }).disabled).toBe(true);
    expect(screen.getByRole('button', { name: 'Clear All' }).disabled).toBe(true);
  });
});
