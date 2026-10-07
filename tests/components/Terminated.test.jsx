import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import Terminated from '../../src/components/Terminated';

describe('Terminated screen', () => {
  it('states why the exam ended', () => {
    const { rerender } = render(<Terminated reason="tab" />);
    expect(screen.getByText('You switched to another tab, window or app.')).toBeTruthy();
    rerender(<Terminated reason="fullscreen" />);
    expect(screen.getByText('You left fullscreen mode.')).toBeTruthy();
    rerender(<Terminated reason="escape" />);
    expect(screen.getByText('You pressed the Escape key.')).toBeTruthy();
    rerender(<Terminated reason="blur" />);
    expect(screen.getByText('The exam window lost focus.')).toBeTruthy();
    rerender(<Terminated reason="ended" />);
    expect(screen.getByText('Your exam attempt was blocked before you submitted it.')).toBeTruthy();
  });

  it('always offers a way out: back to the dashboard or log out', async () => {
    const onBackToDashboard = vi.fn();
    const onLogout = vi.fn();
    render(<Terminated reason="tab" onBackToDashboard={onBackToDashboard} onLogout={onLogout} />);
    await userEvent.click(screen.getByRole('button', { name: /Return to Dashboard/ }));
    await userEvent.click(screen.getByRole('button', { name: /Log out/ }));
    expect(onBackToDashboard).toHaveBeenCalledOnce();
    expect(onLogout).toHaveBeenCalledOnce();
  });
});
