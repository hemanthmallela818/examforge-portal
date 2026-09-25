import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('../../../src/supabase', () => ({
  supabase: { rpc: vi.fn(), from: vi.fn(), functions: { invoke: vi.fn() } }
}));
vi.mock('../../../src/utils', () => ({
  showToast: vi.fn(),
  customAlert: vi.fn(),
  customConfirm: vi.fn(),
  customPrompt: vi.fn()
}));

const { supabase } = await import('../../../src/supabase');
const { customAlert, customConfirm, customPrompt, showToast } = await import('../../../src/utils');
const { AdminContext } = await import('../../../src/features/admin/adminContext');
const { useStudentRoster } = await import('../../../src/features/admin/students/useStudentRoster');
const { default: StudentsView } = await import('../../../src/features/admin/students/StudentsView');

const classes = [
  { id: 'c1', name: '12', sections: ['A', 'B'] },
  { id: 'c2', name: '11', sections: ['C'] }
];

const rosterRows = [
  { id: 'uuid-1', student_id: 'S001', name: 'Asha Rao', class: '12', section: 'A', archived_at: null },
  { id: 'uuid-2', student_id: 'S002', name: 'Vikram Das', class: '11', section: 'C', archived_at: '2026-09-01T00:00:00Z', archive_reason: 'Left school' }
];

const rosterPage = (rows = rosterRows) => ({ data: { page: 0, page_size: 100, total: rows.length, rows }, error: null });

// Minimal but faithful data-load service: runs the work and reports a current result.
const runAdminDataLoad = async (_key, _message, work) => {
  try {
    return { ok: true, current: true, data: await work() };
  } catch (error) {
    return { ok: false, current: true, error };
  }
};

const contextValue = {
  runAdminDataLoad,
  scheduleTableCounts: vi.fn(),
  loadedCollections: { current: new Set() },
  dataLoadState: {},
  classBook: { classes }
};

function Harness() {
  const roster = useStudentRoster({ enabled: true });
  return <StudentsView roster={roster} />;
}

const renderStudents = async () => {
  render(<AdminContext.Provider value={contextValue}><Harness /></AdminContext.Provider>);
  await screen.findByText('Asha Rao');
};

let user;
beforeEach(() => {
  user = userEvent.setup({ delay: null });
  vi.mocked(supabase.rpc).mockReset().mockResolvedValue(rosterPage());
  vi.mocked(supabase.functions.invoke).mockReset().mockResolvedValue({ data: { ok: true }, error: null });
  vi.mocked(customAlert).mockReset().mockResolvedValue(undefined);
  vi.mocked(customConfirm).mockReset().mockResolvedValue(true);
  vi.mocked(customPrompt).mockReset().mockResolvedValue(null);
  vi.mocked(showToast).mockReset();
  contextValue.loadedCollections.current = new Set();
});

describe('StudentsView roster', () => {
  it('loads the first roster page through the paged RPC', async () => {
    await renderStudents();
    expect(supabase.rpc).toHaveBeenCalledWith('get_admin_student_roster_page', {
      page_number_param: 0,
      page_size_param: 100,
      search_param: null,
      class_param: null,
      section_param: null
    });
    expect(screen.getByText('Showing confirmed rows 1-2 of 2.')).toBeTruthy();
    expect(screen.getByText('ACTIVE')).toBeTruthy();
    expect(screen.getByText('INACTIVE')).toBeTruthy();
  });

  it('labels every class/section select (provisioning, filters and per-row)', async () => {
    await renderStudents();
    expect(screen.getByRole('combobox', { name: 'Class' })).toBeTruthy();
    expect(screen.getByRole('combobox', { name: 'Section' })).toBeTruthy();
    expect(screen.getByRole('combobox', { name: 'Filter roster by class' })).toBeTruthy();
    expect(screen.getByRole('combobox', { name: 'Filter roster by section' }).disabled).toBe(true);
    const rowClass = screen.getByRole('combobox', { name: 'Class for Asha Rao' });
    const rowSection = screen.getByRole('combobox', { name: 'Section for Asha Rao' });
    expect(rowClass.value).toBe('12');
    expect(rowSection.value).toBe('A');
    expect(within(rowSection).getAllByRole('option').map(o => o.textContent)).toEqual(['N/A', 'A', 'B']);
    // Inactive students cannot be reassigned.
    expect(screen.getByRole('combobox', { name: 'Class for Vikram Das' }).disabled).toBe(true);
    // Every combobox on the screen has an accessible name.
    for (const select of screen.getAllByRole('combobox')) {
      expect(select.getAttribute('aria-label') || select.labels?.[0]?.textContent).toBeTruthy();
    }
  });

  it('filtering by class resets the section filter and re-queries the server', async () => {
    await renderStudents();
    await user.selectOptions(screen.getByRole('combobox', { name: 'Filter roster by class' }), '12');
    const sectionFilter = screen.getByRole('combobox', { name: 'Filter roster by section' });
    expect(sectionFilter.disabled).toBe(false);
    await waitFor(() => expect(supabase.rpc).toHaveBeenLastCalledWith('get_admin_student_roster_page', expect.objectContaining({ class_param: '12', section_param: null })));
  });

  it('reassigning a row class uses the class default section via the Edge Function', async () => {
    await renderStudents();
    await user.selectOptions(screen.getByRole('combobox', { name: 'Class for Asha Rao' }), '11');
    await waitFor(() => expect(supabase.functions.invoke).toHaveBeenCalledWith('manage-student', {
      body: { action: 'update-assignment', studentUserId: 'uuid-1', className: '11', section: 'C' }
    }));
    expect(showToast).toHaveBeenCalledWith('Student class updated.', 'success');
  });

  it('never renders stored passwords in the table', async () => {
    await renderStudents();
    expect(screen.getAllByText('Hidden · use Reset')).toHaveLength(2);
  });
});

describe('password reset credentials modal', () => {
  const resetButtons = () => screen.getAllByRole('button', { name: /Reset/ });

  it('shows the new password exactly once, then forgets it', async () => {
    vi.mocked(customPrompt).mockResolvedValue('  new-secret-pass-123  ');
    await renderStudents();
    await user.click(resetButtons()[0]);

    await waitFor(() => expect(supabase.functions.invoke).toHaveBeenCalledWith('manage-student', {
      body: { action: 'reset-student-password', studentUserId: 'uuid-1', password: 'new-secret-pass-123' }
    }));
    const dialog = await screen.findByRole('dialog', { name: 'Password Reset' });
    expect(within(dialog).getByText('new-secret-pass-123')).toBeTruthy();
    expect(within(dialog).getByText('S001')).toBeTruthy();
    expect(within(dialog).getByText('Class 12 — Section A')).toBeTruthy();
    expect(within(dialog).getByText(/The password is shown only once/)).toBeTruthy();
    expect(showToast).toHaveBeenCalledWith('Password updated for Asha Rao.', 'success');

    await user.click(within(dialog).getByRole('button', { name: 'Done' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByText('new-secret-pass-123')).toBeNull();
  });

  it('copies all credentials to the clipboard', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    vi.mocked(customPrompt).mockResolvedValue('another-long-pass');
    await renderStudents();
    await user.click(resetButtons()[0]);
    const dialog = await screen.findByRole('dialog', { name: 'Password Reset' });
    await user.click(within(dialog).getByRole('button', { name: 'Copy All Credentials' }));
    expect(writeText).toHaveBeenCalledWith('Student Name: Asha Rao\nStudent ID: S001\nPassword: another-long-pass\nClass: 12 (A)');
    expect(showToast).toHaveBeenCalledWith('Credentials copied to clipboard!', 'success');
  });

  it('rejects a short password without calling the server', async () => {
    vi.mocked(customPrompt).mockResolvedValue('short');
    await renderStudents();
    await user.click(resetButtons()[0]);
    await waitFor(() => expect(customAlert).toHaveBeenCalledWith('Password must be between 12 and 128 characters.'));
    expect(supabase.functions.invoke).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('does nothing when the prompt is cancelled', async () => {
    await renderStudents();
    await user.click(resetButtons()[0]);
    await waitFor(() => expect(customPrompt).toHaveBeenCalled());
    expect(supabase.functions.invoke).not.toHaveBeenCalled();
  });

  it('reports a server failure and shows no credentials', async () => {
    vi.mocked(customPrompt).mockResolvedValue('valid-password-1234');
    vi.mocked(supabase.functions.invoke).mockResolvedValue({ data: null, error: new Error('forbidden') });
    await renderStudents();
    await user.click(resetButtons()[0]);
    await waitFor(() => expect(customAlert).toHaveBeenCalledWith('Failed to reset password: forbidden'));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('disables Reset for inactive students', async () => {
    await renderStudents();
    const buttons = resetButtons().filter(button => button.title === 'Set or reset student password');
    expect(buttons.map(button => button.disabled)).toEqual([false, true]);
  });
});
