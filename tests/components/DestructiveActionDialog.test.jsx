import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import DestructiveActionDialog from '../../src/components/DestructiveActionDialog';

// delay: null keeps typing synchronous-fast while still dispatching full event sequences.
let user;
beforeEach(() => { user = userEvent.setup({ delay: null }); });

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};

const makeAction = (overrides = {}) => ({
  title: 'Delete all results',
  description: 'Removes every submitted attempt.',
  impact: [{ label: 'Results', count: 1234 }, { label: 'Snapshots', count: Number.NaN }],
  preserved: ['Questions', 'Students'],
  phrase: 'DELETE RESULTS',
  confirmLabel: 'Delete results',
  run: vi.fn().mockResolvedValue('Deleted 1,234 results.'),
  ...overrides
});

const phraseInput = () => screen.getByRole('textbox', { name: /to confirm/ });

describe('DestructiveActionDialog', () => {
  it('renders a labelled dialog with impact, preserved items and the phrase', () => {
    render(<DestructiveActionDialog action={makeAction()} onClose={vi.fn()} />);
    const dialog = screen.getByRole('dialog', { name: 'Delete all results' });
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(screen.getByText('Removes every submitted attempt.')).toBeTruthy();
    expect(screen.getByText('Results').nextSibling.textContent).toBe((1234).toLocaleString());
    expect(screen.getByText('Snapshots').nextSibling.textContent).toBe('Unknown');
    expect(screen.getByText(/Questions, Students\./)).toBeTruthy();
    expect(phraseInput()).toBeTruthy();
  });

  it('keeps confirm disabled until the exact phrase is typed', async () => {
    const action = makeAction();
    render(<DestructiveActionDialog action={action} onClose={vi.fn()} />);
    const confirm = screen.getByRole('button', { name: 'Delete results' });
    expect(confirm.disabled).toBe(true);

    await user.type(phraseInput(), 'delete results');
    expect(confirm.disabled).toBe(true);
    await user.clear(phraseInput());
    await user.type(phraseInput(), 'DELETE RESULTS ');
    expect(confirm.disabled).toBe(true);
    await user.type(phraseInput(), '{Backspace}');
    expect(confirm.disabled).toBe(false);

    // Submitting via Enter with the wrong phrase must not run the action.
    await user.clear(phraseInput());
    await user.type(phraseInput(), 'DELETE{Enter}');
    expect(action.run).not.toHaveBeenCalled();
  });

  it('runs the action with the phrase, shows progress and then the result', async () => {
    const pending = deferred();
    const action = makeAction({ run: vi.fn(() => pending.promise) });
    const onClose = vi.fn();
    render(<DestructiveActionDialog action={action} onClose={onClose} />);
    await user.type(phraseInput(), 'DELETE RESULTS');
    await user.click(screen.getByRole('button', { name: 'Delete results' }));

    expect(action.run).toHaveBeenCalledWith('DELETE RESULTS');
    const working = screen.getByRole('button', { name: 'Working…' });
    expect(working.disabled).toBe(true);
    expect(working.getAttribute('aria-busy')).toBe('true');
    expect(screen.getByRole('button', { name: 'Cancel' }).disabled).toBe(true);
    expect(phraseInput().disabled).toBe(true);

    pending.resolve('Deleted 1,234 results.');
    expect((await screen.findByRole('status')).textContent).toContain('Deleted 1,234 results.');
    expect(screen.queryByRole('textbox')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Done' }));
    expect(onClose).toHaveBeenCalledWith(true);
  });

  it('uses a default success message when the action returns nothing', async () => {
    render(<DestructiveActionDialog action={makeAction({ run: vi.fn().mockResolvedValue(undefined) })} onClose={vi.fn()} />);
    await user.type(phraseInput(), 'DELETE RESULTS');
    await user.click(screen.getByRole('button', { name: 'Delete results' }));
    expect((await screen.findByRole('status')).textContent).toContain('Completed successfully.');
  });

  it('shows the error and offers Retry, which runs the action again', async () => {
    const run = vi.fn()
      .mockRejectedValueOnce(new Error('Permission denied'))
      .mockResolvedValueOnce('All clear.');
    render(<DestructiveActionDialog action={makeAction({ run })} onClose={vi.fn()} />);
    await user.type(phraseInput(), 'DELETE RESULTS');
    await user.click(screen.getByRole('button', { name: 'Delete results' }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Permission denied');
    expect(phraseInput().getAttribute('aria-describedby')).toBe(alert.id);
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(run).toHaveBeenCalledTimes(2);
    expect((await screen.findByRole('status')).textContent).toContain('All clear.');
  });

  it('falls back to a generic error when the failure has no message', async () => {
    render(<DestructiveActionDialog action={makeAction({ run: vi.fn().mockRejectedValue({}) })} onClose={vi.fn()} />);
    await user.type(phraseInput(), 'DELETE RESULTS');
    await user.click(screen.getByRole('button', { name: 'Delete results' }));
    expect((await screen.findByRole('alert')).textContent).toContain('No confirmation was received from the server.');
  });

  it('closes without success on Cancel and Escape', async () => {
    const onClose = vi.fn();
    render(<DestructiveActionDialog action={makeAction()} onClose={onClose} />);
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenLastCalledWith(false);
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(2);
    expect(onClose).toHaveBeenLastCalledWith(false);
  });
});
