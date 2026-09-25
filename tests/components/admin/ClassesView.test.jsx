import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('../../../src/supabase', () => ({ supabase: { rpc: vi.fn(), from: vi.fn() } }));
vi.mock('../../../src/utils', () => ({
  showToast: vi.fn(),
  customAlert: vi.fn(),
  customConfirm: vi.fn(),
  customPrompt: vi.fn()
}));

const { supabase } = await import('../../../src/supabase');
const { customAlert, customConfirm, customPrompt, showToast } = await import('../../../src/utils');
const { AdminContext } = await import('../../../src/features/admin/adminContext');
const { useClasses } = await import('../../../src/features/admin/classes/useClasses');
const { default: ClassesView } = await import('../../../src/features/admin/classes/ClassesView');

let classRows;
let insert;

// `from('classes')` supports both the paged list (select/order/order/range) and insert.
const classesTable = () => {
  const builder = {
    select: () => builder,
    order: () => builder,
    range: (from, to) => Promise.resolve({ data: classRows.slice(from, to + 1), error: null }),
    insert
  };
  return builder;
};

const runAdminDataLoad = async (_key, _message, work) => ({ ok: true, current: true, data: await work() });

function Harness() {
  const classBook = useClasses({
    runAdminDataLoad,
    scheduleTableCounts: () => {},
    loadedCollections: { current: new Set() }
  });
  const { fetchClasses } = classBook;
  return (
    <AdminContext.Provider value={{ classBook }}>
      <button type="button" onClick={fetchClasses}>Load classes</button>
      <ClassesView />
    </AdminContext.Provider>
  );
}

let user;
const renderClasses = async () => {
  render(<Harness />);
  await user.click(screen.getByRole('button', { name: 'Load classes' }));
  if (classRows.length > 0) await screen.findByText(classRows[0].name);
};

const nameInput = () => screen.getByRole('textbox', { name: 'Class name' });
const sectionsInput = () => screen.getByRole('textbox', { name: 'Sections' });
const createButton = () => screen.getByRole('button', { name: 'Create Class' });

beforeEach(() => {
  user = userEvent.setup({ delay: null });
  classRows = [
    { id: 'c1', name: 'Class 12', sections: ['A', 'B'] },
    { id: 'c2', name: 'Class 11', sections: null }
  ];
  insert = vi.fn().mockResolvedValue({ error: null });
  vi.mocked(supabase.from).mockReset().mockImplementation(classesTable);
  vi.mocked(supabase.rpc).mockReset().mockResolvedValue({ data: null, error: null });
  vi.mocked(customAlert).mockReset().mockResolvedValue(undefined);
  vi.mocked(customConfirm).mockReset().mockResolvedValue(true);
  vi.mocked(customPrompt).mockReset().mockResolvedValue(null);
  vi.mocked(showToast).mockReset();
});

describe('ClassesView listing', () => {
  it('lists classes with section badges and a count', async () => {
    await renderClasses();
    expect(screen.getByText('2 classes')).toBeTruthy();
    const row = screen.getByRole('row', { name: /Class 12/ });
    expect(within(row).getByText('A')).toBeTruthy();
    expect(within(row).getByText('B')).toBeTruthy();
  });

  it('shows the empty state when there are no classes', async () => {
    classRows = [];
    await renderClasses();
    expect(screen.getByText('No classes found')).toBeTruthy();
    expect(screen.getByText('0 classes')).toBeTruthy();
  });
});

describe('creating a class', () => {
  it.each([
    ['', 'A, B', 'Please enter a class name and sections first.'],
    ['Class 10', '   ', 'Please enter a class name and sections first.'],
    ['Class 10', ' , ,', 'Please enter at least one valid section.']
  ])('rejects name=%j sections=%j', async (name, sections, message) => {
    await renderClasses();
    if (name) await user.type(nameInput(), name);
    if (sections) await user.type(sectionsInput(), sections);
    await user.click(createButton());
    await waitFor(() => expect(customAlert).toHaveBeenCalledWith(message));
    expect(insert).not.toHaveBeenCalled();
  });

  it('trims the name, upper-cases sections, drops blanks and clears the form', async () => {
    await renderClasses();
    await user.type(nameInput(), '  Class 10 ');
    await user.type(sectionsInput(), 'a, b ,, c');
    await user.click(createButton());
    await waitFor(() => expect(insert).toHaveBeenCalledWith({ name: 'Class 10', sections: ['A', 'B', 'C'] }));
    expect(customAlert).toHaveBeenCalledWith('Class created successfully!');
    expect(nameInput().value).toBe('');
    expect(sectionsInput().value).toBe('');
  });

  it('submits with Enter from the sections field', async () => {
    await renderClasses();
    await user.type(nameInput(), 'Class 9');
    await user.type(sectionsInput(), 'A{Enter}');
    await waitFor(() => expect(insert).toHaveBeenCalledWith({ name: 'Class 9', sections: ['A'] }));
  });

  it('reports a server failure and keeps the typed values', async () => {
    insert.mockResolvedValue({ error: new Error('duplicate key value') });
    await renderClasses();
    await user.type(nameInput(), 'Class 12');
    await user.type(sectionsInput(), 'A');
    await user.click(createButton());
    await waitFor(() => expect(customAlert).toHaveBeenCalledWith('Failed to create class: duplicate key value'));
    expect(nameInput().value).toBe('Class 12');
  });
});

describe('deleting a class', () => {
  const deleteButtonFor = (name) => within(screen.getByRole('row', { name: new RegExp(name) })).getByRole('button', { name: 'Delete' });

  it('does nothing when the name prompt is cancelled', async () => {
    await renderClasses();
    await user.click(deleteButtonFor('Class 12'));
    await waitFor(() => expect(customPrompt).toHaveBeenCalledWith('Type the exact class name to delete it:\n\nClass 12'));
    expect(customConfirm).not.toHaveBeenCalled();
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  it('cancels when the typed name does not match exactly', async () => {
    vi.mocked(customPrompt).mockResolvedValue('class 12');
    await renderClasses();
    await user.click(deleteButtonFor('Class 12'));
    await waitFor(() => expect(customAlert).toHaveBeenCalledWith('Class deletion cancelled because the name did not match exactly.'));
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  it('stops when the final confirmation is declined', async () => {
    vi.mocked(customPrompt).mockResolvedValue('Class 12');
    vi.mocked(customConfirm).mockResolvedValue(false);
    await renderClasses();
    await user.click(deleteButtonFor('Class 12'));
    await waitFor(() => expect(customConfirm).toHaveBeenCalledWith('Permanently delete the empty class "Class 12"?'));
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  it('deletes through the empty-class RPC with the confirmed name and reloads', async () => {
    vi.mocked(customPrompt).mockResolvedValue('Class 12');
    await renderClasses();
    const fromCallsBefore = vi.mocked(supabase.from).mock.calls.length;
    await user.click(deleteButtonFor('Class 12'));
    await waitFor(() => expect(supabase.rpc).toHaveBeenCalledWith('admin_delete_empty_class', {
      class_id_param: 'c1',
      expected_name_param: 'Class 12'
    }));
    expect(showToast).toHaveBeenCalledWith('Empty class deleted successfully.', 'success');
    await waitFor(() => expect(vi.mocked(supabase.from).mock.calls.length).toBeGreaterThan(fromCallsBefore));
  });

  it('reports the server refusal (e.g. class still has students)', async () => {
    vi.mocked(customPrompt).mockResolvedValue('Class 11');
    vi.mocked(supabase.rpc).mockResolvedValue({ data: null, error: new Error('Class is not empty') });
    await renderClasses();
    await user.click(deleteButtonFor('Class 11'));
    await waitFor(() => expect(customAlert).toHaveBeenCalledWith('Failed to delete class: Class is not empty'));
    expect(showToast).not.toHaveBeenCalled();
  });
});

describe('ClassesView sorting and filtering', () => {
  const classNames = () => screen.getAllByRole('row').slice(1).map(row => within(row).getAllByRole('cell')[0].textContent);

  beforeEach(() => {
    classRows = [
      { id: 'c10', name: 'Class 10', sections: ['A'] },
      { id: 'c2', name: 'Class 2', sections: ['A', 'B', 'C'] },
      { id: 'c9', name: 'Class 9', sections: ['D', 'E'] }
    ];
  });

  it('sorts by name (numeric-aware, ascending by default) and by section count', async () => {
    await renderClasses();
    const nameHeader = screen.getByRole('columnheader', { name: 'Class Name' });
    expect(nameHeader.getAttribute('aria-sort')).toBe('ascending');
    expect(classNames()).toEqual(['Class 2', 'Class 9', 'Class 10']);

    await user.click(screen.getByRole('button', { name: 'Class Name' }));
    expect(nameHeader.getAttribute('aria-sort')).toBe('descending');
    expect(classNames()).toEqual(['Class 10', 'Class 9', 'Class 2']);

    await user.click(screen.getByRole('button', { name: 'Sections' }));
    expect(screen.getByRole('columnheader', { name: 'Sections' }).getAttribute('aria-sort')).toBe('ascending');
    expect(nameHeader.getAttribute('aria-sort')).toBeNull();
    expect(classNames()).toEqual(['Class 10', 'Class 9', 'Class 2']);
  });

  it('filters by class name or exact section and reports the match count', async () => {
    await renderClasses();
    const filter = screen.getByRole('searchbox', { name: 'Filter classes by name or section' });
    await user.type(filter, 'd');
    expect(classNames()).toEqual(['Class 9']);
    expect(screen.getByRole('status').textContent).toBe('Showing 1 of 3');
    await user.clear(filter);
    await user.type(filter, 'class 1');
    expect(classNames()).toEqual(['Class 10']);
    await user.clear(filter);
    await user.type(filter, 'nothing');
    expect(screen.getByText('No classes match this filter.')).toBeTruthy();
    // The total badge still counts every class.
    expect(screen.getByText('3 classes')).toBeTruthy();
  });
});
