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
const { useStudentRoster, BULK_MOVE_CONCURRENCY } = await import('../../../src/features/admin/students/useStudentRoster');
const { default: StudentsView } = await import('../../../src/features/admin/students/StudentsView');

const classes = [
  { id: 'c1', name: '12', sections: ['A', 'B', 'C'] },
  { id: 'c2', name: '11', sections: ['C'] }
];

// Server order is by student ID.
const rosterRows = [
  { id: 'uuid-1', student_id: 'S001', name: 'Meera Iyer', class: '12', section: 'B', archived_at: null },
  { id: 'uuid-2', student_id: 'S002', name: 'Asha Rao', class: '12', section: 'A', archived_at: null },
  { id: 'uuid-3', student_id: 'S003', name: 'Zoya Khan', class: '12', section: 'A', archived_at: null },
  { id: 'uuid-4', student_id: 'S004', name: 'Dev Patel', class: '11', section: 'C', archived_at: null },
  { id: 'uuid-5', student_id: 'S005', name: 'Kabir Sen', class: '12', section: 'C', archived_at: '2026-09-01T00:00:00Z', archive_reason: 'Left' }
];

const rosterPage = () => ({ data: { page: 0, page_size: 100, total: rosterRows.length, rows: rosterRows }, error: null });

const contextValue = {
  runAdminDataLoad: async (_key, _message, work) => ({ ok: true, current: true, data: await work() }),
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

const rosterTable = () => screen.getByRole('region', { name: 'Student roster table' });
const rowNames = () => within(rosterTable()).getAllByRole('row').slice(1)
  .map(row => within(row).getAllByRole('cell')[1].textContent);
const header = name => within(rosterTable()).getByRole('columnheader', { name });
const select = name => user.click(screen.getByRole('checkbox', { name: `Select ${name} on this page` }));

let user;
beforeEach(() => {
  user = userEvent.setup({ delay: null });
  vi.mocked(supabase.rpc).mockReset().mockResolvedValue(rosterPage());
  vi.mocked(supabase.functions.invoke).mockReset().mockResolvedValue({ data: { ok: true }, error: null });
  vi.mocked(customAlert).mockReset().mockResolvedValue(undefined);
  vi.mocked(customConfirm).mockReset().mockResolvedValue(true);
  vi.mocked(customPrompt).mockReset().mockResolvedValue(null);
  vi.mocked(showToast).mockReset();
});

// Many full-table role queries per test; allow for a loaded parallel run.
describe('roster column sorting (current page only)', { timeout: 20_000 }, () => {
  it('sorts by name, student ID, class, section and status with aria-sort', async () => {
    await renderStudents();
    expect(rowNames()).toEqual(['Meera Iyer', 'Asha Rao', 'Zoya Khan', 'Dev Patel', 'Kabir Sen']);

    await user.click(within(rosterTable()).getByRole('button', { name: 'Student Name' }));
    expect(header('Student Name').getAttribute('aria-sort')).toBe('ascending');
    expect(rowNames()).toEqual(['Asha Rao', 'Dev Patel', 'Kabir Sen', 'Meera Iyer', 'Zoya Khan']);
    expect(screen.getByText(/Sorting reorders the rows on this page only/)).toBeTruthy();

    await user.click(within(rosterTable()).getByRole('button', { name: 'Student Name' }));
    expect(header('Student Name').getAttribute('aria-sort')).toBe('descending');
    expect(rowNames()[0]).toBe('Zoya Khan');

    await user.click(within(rosterTable()).getByRole('button', { name: 'Student ID (Username)' }));
    expect(header('Student Name').getAttribute('aria-sort')).toBeNull();
    expect(rowNames()).toEqual(['Meera Iyer', 'Asha Rao', 'Zoya Khan', 'Dev Patel', 'Kabir Sen']);

    await user.click(within(rosterTable()).getByRole('button', { name: 'Class' }));
    expect(rowNames()[0]).toBe('Dev Patel');

    await user.click(within(rosterTable()).getByRole('button', { name: 'Section' }));
    expect(rowNames()).toEqual(['Asha Rao', 'Zoya Khan', 'Meera Iyer', 'Dev Patel', 'Kabir Sen']);

    await user.click(within(rosterTable()).getByRole('button', { name: 'Status' }));
    expect(rowNames().at(-1)).toBe('Kabir Sen');
    await user.click(within(rosterTable()).getByRole('button', { name: 'Status' }));
    expect(rowNames()[0]).toBe('Kabir Sen');

    await user.click(screen.getByRole('button', { name: 'Clear sort' }));
    expect(rowNames()).toEqual(['Meera Iyer', 'Asha Rao', 'Zoya Khan', 'Dev Patel', 'Kabir Sen']);
    // Sorting never re-queries the server: the RPC has no ordering parameter.
    expect(supabase.rpc).toHaveBeenCalledTimes(1);
  }, 20_000);

  it('keeps per-row controls labelled after sorting and filters the page by status', async () => {
    await renderStudents();
    await user.click(within(rosterTable()).getByRole('button', { name: 'Student Name' }));
    expect(screen.getByRole('combobox', { name: 'Class for Asha Rao' }).value).toBe('12');
    expect(screen.getByRole('combobox', { name: 'Section for Asha Rao' }).value).toBe('A');

    await user.selectOptions(screen.getByRole('combobox', { name: 'Filter this page by status' }), 'inactive');
    expect(rowNames()).toEqual(['Kabir Sen']);
    await user.selectOptions(screen.getByRole('combobox', { name: 'Filter this page by status' }), 'active');
    expect(rowNames()).not.toContain('Kabir Sen');
    expect(rowNames()).toHaveLength(4);
  });
});

describe('bulk "Move to section…"', { timeout: 20_000 }, () => {
  const moveButton = () => screen.getByRole('button', { name: 'Move to section…' });

  it('is only available for students of one class with another section', async () => {
    await renderStudents();
    expect(screen.queryByRole('button', { name: 'Move to section…' })).toBeNull();
    await select('Asha Rao');
    expect(moveButton().disabled).toBe(false);
    expect(screen.getByRole('button', { name: /Deactivate Selected \(1\)/ })).toBeTruthy();

    await select('Dev Patel');
    expect(moveButton().disabled).toBe(true);
    expect(screen.getByText('Select students from one class to move them between sections.')).toBeTruthy();

    await select('Asha Rao');
    expect(moveButton().disabled).toBe(true);
    expect(screen.getByText('Class 11 has only one section.')).toBeTruthy();
  });

  it('moves each student through the trusted update path, reports progress and reloads', async () => {
    await renderStudents();
    await select('Asha Rao');
    await select('Zoya Khan');
    await select('Meera Iyer');
    await user.click(moveButton());

    const dialog = await screen.findByRole('dialog', { name: 'Move students to another section' });
    expect(within(dialog).getByText(/3 students selected in Class 12/)).toBeTruthy();
    const target = within(dialog).getByRole('combobox', { name: 'Target section' });
    // Defaults to the first section none of the selected students is in.
    expect(target.value).toBe('C');
    await user.selectOptions(target, 'B');
    await user.click(within(dialog).getByRole('button', { name: 'Move 3 students' }));

    await within(dialog).findByText('3 of 3 processed.');
    // Meera is already in B: no call for her.
    expect(supabase.functions.invoke).toHaveBeenCalledTimes(2);
    for (const id of ['uuid-2', 'uuid-3']) {
      expect(supabase.functions.invoke).toHaveBeenCalledWith('manage-student', {
        body: { action: 'update-assignment', studentUserId: id, className: '12', section: 'B' }
      });
    }
    expect(within(dialog).getByText(/2 moved to Section B, 1 already there/)).toBeTruthy();
    expect(within(dialog).getByRole('progressbar', { name: 'Section move progress' })).toBeTruthy();
    expect(showToast).toHaveBeenCalledWith('2 student(s) moved to Section B.', 'success');
    // The roster page is reloaded and the selection cleared.
    await waitFor(() => expect(supabase.rpc).toHaveBeenCalledTimes(2));
    await user.click(within(dialog).getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByRole('button', { name: /Deactivate Selected/ })).toBeNull();
  });

  it('lists per-student failures with the server message and keeps them selected', async () => {
    vi.mocked(supabase.functions.invoke).mockImplementation(async (_name, { body }) => (
      body.studentUserId === 'uuid-3'
        ? { data: { error: 'Section is full', correlationId: 'abcdef12' }, error: new Error('Edge Function returned a non-2xx status code') }
        : { data: { ok: true }, error: null }
    ));
    await renderStudents();
    await select('Asha Rao');
    await select('Zoya Khan');
    await user.click(moveButton());
    const dialog = await screen.findByRole('dialog', { name: 'Move students to another section' });
    await user.click(within(dialog).getByRole('button', { name: 'Move 2 students' }));

    const failures = await within(dialog).findByRole('list', { name: 'Failed moves' });
    expect(within(failures).getAllByRole('listitem')).toHaveLength(1);
    expect(failures.textContent).toContain('Zoya Khan (S003): Section is full (Reference: abcdef12)');
    expect(within(dialog).getByText(/1 could not be moved/)).toBeTruthy();
    expect(showToast).toHaveBeenCalledWith('1 student(s) moved to Section B.', 'warning');

    await user.click(within(dialog).getByRole('button', { name: 'Close' }));
    expect(screen.getByRole('checkbox', { name: 'Select Zoya Khan on this page' }).checked).toBe(true);
    expect(screen.getByRole('checkbox', { name: 'Select Asha Rao on this page' }).checked).toBe(false);
  });

  it(`never runs more than ${BULK_MOVE_CONCURRENCY} updates at once`, async () => {
    let inFlight = 0;
    let peak = 0;
    vi.mocked(supabase.functions.invoke).mockImplementation(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise(resolve => setTimeout(resolve, 5));
      inFlight -= 1;
      return { data: { ok: true }, error: null };
    });
    const many = Array.from({ length: 7 }, (_, i) => ({
      id: `bulk-${i}`, student_id: `B${i}`, name: `Bulk Student ${i}`, class: '12', section: 'A', archived_at: null
    }));
    vi.mocked(supabase.rpc).mockResolvedValue({ data: { page: 0, page_size: 100, total: many.length, rows: many }, error: null });
    render(<AdminContext.Provider value={contextValue}><Harness /></AdminContext.Provider>);
    await screen.findByText('Bulk Student 0');
    await user.click(screen.getByRole('checkbox', { name: 'Select all active students on this page' }));
    await user.click(moveButton());
    const dialog = await screen.findByRole('dialog', { name: 'Move students to another section' });
    await user.click(within(dialog).getByRole('button', { name: 'Move 7 students' }));
    await within(dialog).findByText('7 of 7 processed.');
    expect(supabase.functions.invoke).toHaveBeenCalledTimes(7);
    expect(peak).toBeLessThanOrEqual(BULK_MOVE_CONCURRENCY);
    expect(peak).toBeGreaterThan(1);
  });
});
