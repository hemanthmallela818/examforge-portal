import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('../../src/supabase', () => ({ supabase: { rpc: vi.fn() } }));
vi.mock('../../src/utils', () => ({ showToast: vi.fn(), customConfirm: vi.fn() }));

const { supabase } = await import('../../src/supabase');
const { customConfirm, showToast } = await import('../../src/utils');
const { default: SubjectsAndPatternsView } = await import('../../src/components/SubjectsAndPatternsView');

// delay: null keeps typing synchronous-fast while still dispatching full event sequences.
let user;
beforeEach(() => { user = userEvent.setup({ delay: null }); });

const subjects = [
  { id: 's1', name: 'Physics', isActive: true, usage: { questions: 12, templates: 1, exams: 2 } },
  { id: 's2', name: 'Biology', isActive: true, usage: { questions: 0, templates: 0, exams: 0 } },
  { id: 's3', name: 'Geology', isActive: false, usage: {} }
];

const templates = [{
  id: 't1',
  name: 'JEE Main',
  description: 'Three sections',
  durationMinutes: 180,
  marksCorrect: 4,
  marksIncorrect: -1,
  isActive: true,
  totalQuestions: 25,
  sections: [{ subject: 'Physics', questionCount: 25 }],
  inactiveSubjects: []
}];

const renderView = (overrides = {}) => {
  const props = { subjects, templates, loading: false, error: '', onReload: vi.fn().mockResolvedValue(undefined), ...overrides };
  render(<SubjectsAndPatternsView {...props} />);
  return props;
};

const newSubjectInput = () => screen.getByRole('textbox', { name: 'New subject' });
const addButton = () => screen.getByRole('button', { name: 'Add subject' });

beforeEach(() => {
  vi.mocked(supabase.rpc).mockReset().mockResolvedValue({ data: null, error: null });
  vi.mocked(customConfirm).mockReset().mockResolvedValue(true);
  vi.mocked(showToast).mockReset();
});

describe('SubjectsAndPatternsView shell', () => {
  it('shows a loading block before the first load', () => {
    renderView({ subjects: [], loading: true });
    expect(screen.getByText('Loading subjects and patterns…')).toBeTruthy();
    expect(screen.queryByRole('textbox', { name: 'New subject' })).toBeNull();
  });

  it('shows a load error with Retry', async () => {
    const props = renderView({ error: 'Network unreachable' });
    const alert = screen.getAllByRole('alert')[0];
    expect(alert.textContent).toContain('Subjects and patterns could not be loaded');
    expect(alert.textContent).toContain('Network unreachable');
    await user.click(within(alert).getByRole('button', { name: 'Retry' }));
    expect(props.onReload).toHaveBeenCalledTimes(1);
  });

  it('lists subjects with usage and counts', () => {
    renderView();
    expect(screen.getByText('2 active · 3 total')).toBeTruthy();
    const list = screen.getByRole('list', { name: 'Configured subjects' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(3);
    expect(screen.getByText('12 question(s) · 1 pattern(s) · 2 exam(s)')).toBeTruthy();
    expect(screen.getByText('Inactive')).toBeTruthy();
  });
});

describe('adding a subject', () => {
  it.each([
    ['   ', 'Enter a subject name.'],
    ['#Chem', "Use letters, numbers, spaces and & ( ) . , / + ' - only, starting with a letter or number."],
    ['Chem<script>', "Use letters, numbers, spaces and & ( ) . , / + ' - only, starting with a letter or number."],
    ['  physics ', 'A subject named "physics" already exists.']
  ])('rejects %j with a validation message', async (value, message) => {
    renderView();
    await user.type(newSubjectInput(), value);
    await user.click(addButton());
    expect(screen.getByText(message)).toBeTruthy();
    expect(newSubjectInput().getAttribute('aria-invalid')).toBe('true');
    expect(supabase.rpc).not.toHaveBeenCalled();

    await user.type(newSubjectInput(), 'x');
    expect(screen.queryByText(message)).toBeNull();
  });

  it('limits names to 60 characters in the input', () => {
    renderView();
    expect(newSubjectInput().getAttribute('maxlength')).toBe('60');
  });

  it('saves a normalised name, clears the field and reloads', async () => {
    const props = renderView();
    await user.type(newSubjectInput(), '  Computer   Science & IT ');
    await user.click(addButton());
    await waitFor(() => expect(props.onReload).toHaveBeenCalledTimes(1));
    expect(supabase.rpc).toHaveBeenCalledWith('admin_save_subject', {
      subject_id_param: null,
      name_param: 'Computer Science & IT',
      is_active_param: true
    });
    expect(showToast).toHaveBeenCalledWith('Subject "Computer Science & IT" added.', 'success');
    expect(newSubjectInput().value).toBe('');
  });

  it('shows the server error without its SQL prefix', async () => {
    vi.mocked(supabase.rpc).mockResolvedValue({ error: { message: 'P0001: ERROR: Subject limit reached' } });
    const props = renderView();
    await user.type(newSubjectInput(), 'Botany');
    await user.click(addButton());
    expect(await screen.findByText('Subject limit reached')).toBeTruthy();
    expect(props.onReload).not.toHaveBeenCalled();
    expect(newSubjectInput().value).toBe('Botany');
  });
});

describe('editing subjects', () => {
  it('disables rename and delete for subjects that are in use', () => {
    renderView();
    const rename = screen.getByRole('button', { name: 'Rename Physics' });
    const remove = screen.getByRole('button', { name: 'Delete Physics' });
    expect(rename.disabled).toBe(true);
    expect(remove.disabled).toBe(true);
    expect(rename.getAttribute('title')).toBe('Subjects that are in use keep their name. Create a new subject instead.');
    expect(remove.getAttribute('title')).toBe('Subjects that are in use cannot be deleted. Deactivate it instead.');
    expect(screen.getByRole('button', { name: 'Deactivate Physics' }).disabled).toBe(false);

    expect(screen.getByRole('button', { name: 'Rename Biology' }).disabled).toBe(false);
    expect(screen.getByRole('button', { name: 'Delete Biology' }).disabled).toBe(false);
  });

  it('disables moving the first subject up and the last subject down', () => {
    renderView();
    expect(screen.getByRole('button', { name: 'Move Physics up' }).disabled).toBe(true);
    expect(screen.getByRole('button', { name: 'Move Geology down' }).disabled).toBe(true);
    expect(screen.getByRole('button', { name: 'Move Biology up' }).disabled).toBe(false);
  });

  it('reorders subjects through the RPC', async () => {
    const props = renderView();
    await user.click(screen.getByRole('button', { name: 'Move Biology up' }));
    await waitFor(() => expect(props.onReload).toHaveBeenCalled());
    expect(supabase.rpc).toHaveBeenCalledWith('admin_reorder_subjects', { ordered_ids_param: ['s2', 's1', 's3'] });
  });

  it('validates and saves a rename of an unused subject', async () => {
    const props = renderView();
    await user.click(screen.getByRole('button', { name: 'Rename Biology' }));
    const input = screen.getByRole('textbox', { name: 'New name for Biology' });
    await user.clear(input);
    await user.type(input, '!Bio');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(screen.getByRole('alert').textContent).toBe("Use up to 60 letters, numbers, spaces and & ( ) . , / + ' - characters.");
    expect(supabase.rpc).not.toHaveBeenCalled();

    await user.clear(input);
    await user.type(input, 'Life Sciences{Enter}');
    await waitFor(() => expect(props.onReload).toHaveBeenCalled());
    expect(supabase.rpc).toHaveBeenCalledWith('admin_save_subject', { subject_id_param: 's2', name_param: 'Life Sciences', is_active_param: true });
    expect(showToast).toHaveBeenCalledWith('Subject renamed to "Life Sciences".', 'success');
    expect(screen.queryByRole('textbox', { name: 'New name for Biology' })).toBeNull();
  });

  it('cancels a rename with Escape without saving', async () => {
    renderView();
    await user.click(screen.getByRole('button', { name: 'Rename Biology' }));
    await user.type(screen.getByRole('textbox', { name: 'New name for Biology' }), 'X{Escape}');
    expect(screen.queryByRole('textbox', { name: 'New name for Biology' })).toBeNull();
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  it('reactivates an inactive subject', async () => {
    renderView();
    await user.click(screen.getByRole('button', { name: 'Reactivate Geology' }));
    await waitFor(() => expect(supabase.rpc).toHaveBeenCalledWith('admin_save_subject', { subject_id_param: 's3', name_param: 'Geology', is_active_param: true }));
  });

  it('deletes an unused subject only after confirmation', async () => {
    vi.mocked(customConfirm).mockResolvedValueOnce(false);
    const props = renderView();
    await user.click(screen.getByRole('button', { name: 'Delete Biology' }));
    expect(customConfirm).toHaveBeenCalledWith('Delete the subject "Biology"? This cannot be undone.');
    expect(supabase.rpc).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Delete Biology' }));
    await waitFor(() => expect(props.onReload).toHaveBeenCalled());
    expect(supabase.rpc).toHaveBeenCalledWith('admin_delete_subject', { subject_id_param: 's2' });
  });

  it('shows a row error when the server rejects a change', async () => {
    vi.mocked(supabase.rpc).mockResolvedValue({ error: { message: 'ERROR: Subject is referenced by an exam' } });
    renderView();
    await user.click(screen.getByRole('button', { name: 'Deactivate Biology' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Subject is referenced by an exam');
  });
});

describe('pattern editor', () => {
  const openNewPattern = async () => {
    await user.click(screen.getByRole('button', { name: 'New pattern' }));
    return screen.getByRole('dialog', { name: 'New exam pattern' });
  };

  it('disables New pattern until an active subject exists', () => {
    renderView({ subjects: [{ id: 's3', name: 'Geology', isActive: false, usage: {} }], templates: [] });
    const button = screen.getByRole('button', { name: 'New pattern' });
    expect(button.disabled).toBe(true);
    expect(button.getAttribute('title')).toBe('Add an active subject first');
    expect(screen.getByText('No patterns yet')).toBeTruthy();
  });

  it('shows validation errors only after a save attempt', async () => {
    renderView();
    const dialog = await openNewPattern();
    expect(within(dialog).queryByText('Fix these before saving')).toBeNull();

    await user.click(within(dialog).getByRole('button', { name: 'Save pattern' }));
    const errors = within(dialog).getByRole('alert');
    expect(errors.textContent).toContain('Fix these before saving');
    expect(within(errors).getByText('Enter a pattern name.')).toBeTruthy();
    expect(within(errors).getByText('Choose a subject for section 1.')).toBeTruthy();
    expect(supabase.rpc).not.toHaveBeenCalled();

    const duration = within(dialog).getByLabelText('Duration (minutes)');
    await user.clear(duration);
    await user.type(duration, '0');
    const correct = within(dialog).getByLabelText('Correct answer');
    await user.clear(correct);
    await user.type(correct, '0');
    const wrong = within(dialog).getByLabelText('Wrong answer');
    await user.clear(wrong);
    await user.type(wrong, '2');
    expect(within(errors).getByText('Duration must be a whole number between 1 and 600 minutes.')).toBeTruthy();
    expect(within(errors).getByText('Marks for a correct answer must be greater than 0 and at most 100 (two decimals at most).')).toBeTruthy();
    expect(within(errors).getByText('Marks for a wrong answer must be between -100 and 0 (two decimals at most).')).toBeTruthy();
  });

  it('offers only active subjects and blocks duplicates across sections', async () => {
    renderView();
    const dialog = await openNewPattern();
    const first = within(dialog).getByLabelText('Subject');
    const optionNames = [...first.options].map(option => option.textContent);
    expect(optionNames).toEqual(['Choose a subject…', 'Physics', 'Biology']);

    await user.selectOptions(first, 'Physics');
    await user.click(within(dialog).getByRole('button', { name: 'Add subject section' }));
    const second = within(dialog).getAllByLabelText('Subject')[1];
    expect([...second.options].find(option => option.value === 'Physics').disabled).toBe(true);
    await user.selectOptions(second, 'Biology');

    expect(within(dialog).getByRole('button', { name: 'Add subject section' }).disabled).toBe(true);
    expect(within(dialog).getByText('Every active subject is already in this pattern.')).toBeTruthy();
    expect(within(dialog).getByText('Total: 35 question(s)')).toBeTruthy();
  });

  it('rejects an out-of-range question count', async () => {
    renderView();
    const dialog = await openNewPattern();
    await user.type(within(dialog).getByLabelText('Pattern name'), 'NEET');
    await user.selectOptions(within(dialog).getByLabelText('Subject'), 'Biology');
    const count = within(dialog).getByLabelText('Questions');
    await user.clear(count);
    await user.type(count, '501');
    await user.click(within(dialog).getByRole('button', { name: 'Save pattern' }));
    expect(within(dialog).getByText('Question count for Biology must be a whole number between 1 and 500.')).toBeTruthy();
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  it('saves a valid pattern and closes the editor', async () => {
    const props = renderView();
    const dialog = await openNewPattern();
    await user.type(within(dialog).getByLabelText('Pattern name'), '  NEET   Mock ');
    await user.selectOptions(within(dialog).getByLabelText('Subject'), 'Biology');
    await user.click(within(dialog).getByRole('button', { name: 'Save pattern' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(supabase.rpc).toHaveBeenCalledWith('admin_save_exam_template', {
      template_id_param: null,
      name_param: 'NEET Mock',
      description_param: '',
      duration_minutes_param: 180,
      marks_correct_param: 4,
      marks_incorrect_param: -1,
      sections_param: [{ subject: 'Biology', questionCount: 25 }],
      is_active_param: true
    });
    expect(props.onReload).toHaveBeenCalledTimes(1);
    expect(showToast).toHaveBeenCalledWith('Pattern "NEET Mock" saved.', 'success');
  });

  it('keeps the editor open and shows the server error when saving fails', async () => {
    vi.mocked(supabase.rpc).mockResolvedValue({ error: { message: 'ERROR: A pattern with this name already exists' } });
    renderView();
    const dialog = await openNewPattern();
    await user.type(within(dialog).getByLabelText('Pattern name'), 'JEE Main');
    await user.selectOptions(within(dialog).getByLabelText('Subject'), 'Physics');
    await user.click(within(dialog).getByRole('button', { name: 'Save pattern' }));
    expect(await within(dialog).findByText('A pattern with this name already exists')).toBeTruthy();
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('edits an existing pattern with its id and duplicates without one', async () => {
    renderView();
    await user.click(screen.getByRole('button', { name: 'Edit' }));
    let dialog = screen.getByRole('dialog', { name: 'Edit exam pattern' });
    expect(within(dialog).getByLabelText('Pattern name').value).toBe('JEE Main');
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Duplicate' }));
    dialog = screen.getByRole('dialog', { name: 'New exam pattern' });
    expect(within(dialog).getByLabelText('Pattern name').value).toBe('JEE Main (copy)');
  });

  it('deletes a pattern after confirmation', async () => {
    const props = renderView();
    await user.click(screen.getByRole('button', { name: 'Delete pattern JEE Main' }));
    await waitFor(() => expect(props.onReload).toHaveBeenCalled());
    expect(customConfirm).toHaveBeenCalledWith('Delete the pattern "JEE Main"? Exams already created from it are not affected.');
    expect(supabase.rpc).toHaveBeenCalledWith('admin_delete_exam_template', { template_id_param: 't1' });
  });

  it('warns when a pattern uses inactive subjects', () => {
    renderView({ templates: [{ ...templates[0], inactiveSubjects: ['Geology'] }] });
    expect(screen.getByText(/Uses inactive subject\(s\): Geology\./)).toBeTruthy();
  });
});
