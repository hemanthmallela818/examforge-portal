import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const mocks = vi.hoisted(() => ({
  signInWithPassword: vi.fn(),
  signOut: vi.fn(() => Promise.resolve({ error: null })),
  rpc: vi.fn()
}));

vi.mock('../../src/supabase', () => ({
  supabase: {
    auth: { signInWithPassword: mocks.signInWithPassword, signOut: mocks.signOut },
    rpc: mocks.rpc
  }
}));

import AuthPortal from '../../src/components/AuthPortal';

const invalidCredentials = { data: { user: null, session: null }, error: { status: 400, message: 'Invalid login credentials' } };
const signedIn = { data: { user: { id: 'user-1' }, session: {} }, error: null };
const claim = { data: { session_id: 'session-1', student_id: 'ABC123', name: 'Student', class: '12', section: 'A' }, error: null, status: 200 };

async function submitStudentLogin(studentId = 'abc123') {
  const onStudentLogin = vi.fn();
  render(<AuthPortal onStudentLogin={onStudentLogin} onAdminLogin={vi.fn()} />);
  await userEvent.type(screen.getByLabelText('Student ID'), studentId);
  await userEvent.type(screen.getByLabelText('Password'), 'secret-pass');
  await userEvent.click(screen.getByRole('button', { name: 'Login' }));
  return onStudentLogin;
}

describe('AuthPortal student login domains', () => {
  beforeEach(() => {
    mocks.signInWithPassword.mockReset();
    mocks.rpc.mockReset();
    mocks.rpc.mockResolvedValue(claim);
  });

  it('signs in with the current student domain without trying the legacy one', async () => {
    mocks.signInWithPassword.mockResolvedValue(signedIn);
    const onStudentLogin = await submitStudentLogin();
    await waitFor(() => expect(onStudentLogin).toHaveBeenCalled());
    expect(mocks.signInWithPassword).toHaveBeenCalledTimes(1);
    expect(mocks.signInWithPassword).toHaveBeenCalledWith({ email: 'abc123@students.examforge.invalid', password: 'secret-pass' });
  });

  it('falls back to the legacy student.com domain for accounts not yet migrated', async () => {
    mocks.signInWithPassword.mockResolvedValueOnce(invalidCredentials).mockResolvedValueOnce(signedIn);
    const onStudentLogin = await submitStudentLogin();
    await waitFor(() => expect(onStudentLogin).toHaveBeenCalled());
    expect(mocks.signInWithPassword.mock.calls.map(([args]) => args.email)).toEqual([
      'abc123@students.examforge.invalid',
      'abc123@student.com'
    ]);
  });

  it('reports invalid credentials once both domains reject the password', async () => {
    mocks.signInWithPassword.mockResolvedValue(invalidCredentials);
    await submitStudentLogin();
    expect(await screen.findByText('Invalid Student ID or Password.')).toBeTruthy();
    expect(mocks.signInWithPassword).toHaveBeenCalledTimes(2);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
});
