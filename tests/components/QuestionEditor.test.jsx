import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const upload = vi.fn();
const remove = vi.fn();

vi.mock('../../src/supabase', () => ({
  supabase: { storage: { from: vi.fn(() => ({ upload, remove })) } }
}));
vi.mock('../../src/utils', () => ({
  customAlert: vi.fn(),
  customConfirm: vi.fn(),
  showToast: vi.fn()
}));
vi.mock('../../src/imageValidation', () => ({ validateImageUpload: vi.fn() }));
// Signed-URL loading is covered elsewhere; render the storage path directly.
vi.mock('../../src/components/StorageImage', () => ({
  default: ({ src, alt, className }) => <img src={`signed:${src}`} alt={alt} className={className} />
}));

const { supabase } = await import('../../src/supabase');
const { customAlert } = await import('../../src/utils');
const { validateImageUpload } = await import('../../src/imageValidation');
const { default: QuestionEditor } = await import('../../src/components/QuestionEditor');

const baseQuestion = {
  id: 'q1',
  subject: 'Physics',
  type: 'MCQ',
  text: 'What is $v = u + at$ called?',
  options: ['First equation of motion', 'Second law', '', 'Hooke law'],
  optionImageUrls: [null, null, null, null],
  questionImageUrl: null,
  correctAnswer: 0
};

const renderEditor = (question = baseQuestion, props = {}) => {
  const onSave = vi.fn().mockResolvedValue(true);
  const onCancel = vi.fn();
  render(<QuestionEditor question={question} onSave={onSave} onCancel={onCancel} subjects={['Physics', 'Math']} {...props} />);
  return { onSave, onCancel };
};

const preview = () => screen.getByRole('region', { name: 'Student view preview' });
const pngFile = (name = 'diagram.png') => new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])], name, { type: 'image/png' });
const drop = (zone, files) => fireEvent.drop(zone, { dataTransfer: { files, types: ['Files'] } });

// jsdom cannot decode images or draw on a canvas: stand in for the browser APIs
// the re-encode step uses, reporting a 1600x1200 image.
const OriginalImage = globalThis.Image;
const originalGetContext = HTMLCanvasElement.prototype.getContext;
const originalToBlob = HTMLCanvasElement.prototype.toBlob;
let canvasSizes;

beforeEach(() => {
  canvasSizes = [];
  upload.mockReset().mockResolvedValue({ data: { path: 'x' }, error: null });
  remove.mockReset().mockResolvedValue({ data: [], error: null });
  vi.mocked(supabase.storage.from).mockClear();
  vi.mocked(customAlert).mockReset().mockResolvedValue(undefined);
  vi.mocked(validateImageUpload).mockReset().mockResolvedValue({ valid: true });
  globalThis.Image = class {
    width = 1600;
    height = 1200;
    set src(_value) { queueMicrotask(() => this.onload?.()); }
  };
  HTMLCanvasElement.prototype.getContext = function getContext() { return { drawImage: () => {} }; };
  HTMLCanvasElement.prototype.toBlob = function toBlob(callback, type) {
    canvasSizes.push([this.width, this.height]);
    callback(new Blob(['jpeg-bytes'], { type }));
  };
});

afterEach(() => {
  globalThis.Image = OriginalImage;
  HTMLCanvasElement.prototype.getContext = originalGetContext;
  HTMLCanvasElement.prototype.toBlob = originalToBlob;
});

// The editor renders a large dialog; role queries over it are slow under a parallel run.
describe('QuestionEditor live preview', { timeout: 20_000 }, () => {
  it('renders the draft as candidates see it, next to the editor', () => {
    renderEditor();
    const dialog = screen.getByRole('dialog', { name: 'Edit Question' });
    const region = within(dialog).getByRole('region', { name: 'Student view preview' });
    expect(within(region).getByText('MULTIPLE CHOICE')).toBeTruthy();
    expect(within(region).getByText('Physics')).toBeTruthy();
    // Math is rendered through MathRenderer (KaTeX), not shown as raw delimiters.
    expect(region.querySelector('.katex')).toBeTruthy();
    const options = within(within(region).getByRole('list', { name: 'Answer options' })).getAllByRole('listitem');
    expect(options.map(option => option.textContent)).toEqual([
      'A.First equation of motionCorrect',
      'B.Second law',
      'C.Option C is empty',
      'D.Hooke law'
    ]);
  });

  it('updates as the author types and changes the correct answer', async () => {
    const user = userEvent.setup({ delay: null });
    renderEditor();
    const prompt = screen.getByRole('textbox', { name: 'Question Prompt' });
    await user.clear(prompt);
    expect(within(preview()).getByText('The question prompt will appear here.')).toBeTruthy();
    await user.type(prompt, 'Which law explains recoil?');
    expect(within(preview()).getByText('Which law explains recoil?')).toBeTruthy();

    await user.type(screen.getByRole('textbox', { name: /Option C/ }), 'Third law');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Correct Answer:' }), '2');
    const options = within(preview()).getAllByRole('listitem');
    expect(options[2].textContent).toBe('C.Third lawCorrect');
    expect(options[0].textContent).not.toContain('Correct');
  }, 20_000);

  it('switches to the numerical answer view', async () => {
    const user = userEvent.setup({ delay: null });
    renderEditor();
    await user.selectOptions(screen.getByRole('combobox', { name: 'Question Type' }), 'NUMERICAL');
    expect(within(preview()).getByText('NUMERICAL VALUE TYPE')).toBeTruthy();
    expect(within(preview()).queryByRole('list', { name: 'Answer options' })).toBeNull();
    expect(within(preview()).getByText('not set')).toBeTruthy();
    await user.type(screen.getByRole('spinbutton', { name: /Exact Correct Answer/ }), '9.8');
    expect(within(preview()).getByText('9.8')).toBeTruthy();
  });

  it('shows existing question and option images in the preview', () => {
    renderEditor({ ...baseQuestion, questionImageUrl: 'questions/q.jpg', optionImageUrls: [null, 'questions/b.jpg', null, null] });
    expect(within(preview()).getByRole('img', { name: 'Question context' }).getAttribute('src')).toBe('signed:questions/q.jpg');
    expect(within(preview()).getByRole('img', { name: 'Option B' }).getAttribute('src')).toBe('signed:questions/b.jpg');
  });
});

describe('QuestionEditor image drag and drop', { timeout: 20_000 }, () => {
  it('uploads a dropped question image through validation, re-encode and the private bucket', async () => {
    renderEditor();
    const zone = screen.getByRole('group', { name: 'Question image' });
    const file = pngFile();
    fireEvent.dragEnter(zone, { dataTransfer: { files: [file], types: ['Files'] } });
    expect(zone.getAttribute('data-drag-active')).toBe('true');
    expect(within(zone).getByText('Release to upload')).toBeTruthy();
    drop(zone, [file]);

    await waitFor(() => expect(upload).toHaveBeenCalledTimes(1));
    expect(validateImageUpload).toHaveBeenCalledWith(file);
    expect(supabase.storage.from).toHaveBeenCalledWith('exam-assets');
    const [path, blob, options] = upload.mock.calls[0];
    expect(path).toMatch(/^questions\/[0-9a-f-]{36}\.jpg$/);
    expect(blob.type).toBe('image/jpeg');
    expect(options).toEqual({ contentType: 'image/jpeg', upsert: false });
    // Re-encoded to at most 800px on the long side.
    expect(canvasSizes).toEqual([[800, 600]]);
    expect(await within(preview()).findByRole('img', { name: 'Question context' })).toBeTruthy();
    expect(within(zone).getByRole('img', { name: 'Question' }).getAttribute('src')).toBe(`signed:${path}`);
    expect(zone.getAttribute('data-drag-active')).toBeNull();
  });

  it('uploads a dropped option image into that option only', async () => {
    renderEditor();
    drop(screen.getByRole('group', { name: 'Option C image' }), [pngFile('c.png')]);
    await waitFor(() => expect(upload).toHaveBeenCalledTimes(1));
    const path = upload.mock.calls[0][0];
    const img = await within(preview()).findByRole('img', { name: 'Option C' });
    expect(img.getAttribute('src')).toBe(`signed:${path}`);
    expect(within(preview()).queryByText('Option C is empty')).toBeNull();
    expect(screen.getByRole('button', { name: 'Remove image from option C' })).toBeTruthy();
  });

  it('shows validation errors at the drop zone and does not upload', async () => {
    vi.mocked(validateImageUpload).mockResolvedValue({ valid: false, error: 'SVG files are not permitted due to script and security risks. Use JPEG, PNG, or WebP.' });
    renderEditor();
    const zone = screen.getByRole('group', { name: 'Question image' });
    drop(zone, [new File(['<svg/>'], 'x.svg', { type: 'image/svg+xml' })]);
    const alert = await within(zone).findByRole('alert');
    expect(alert.textContent).toContain('SVG files are not permitted');
    expect(upload).not.toHaveBeenCalled();
    // The fallback button is described by the error for screen-reader users.
    const button = within(zone).getByRole('button', { name: 'Upload Question Image' });
    expect(button.getAttribute('aria-describedby')).toContain(alert.id);
  });

  it('rejects multiple files and non-file drops with a clear message', async () => {
    renderEditor();
    const zone = screen.getByRole('group', { name: 'Option A image' });
    drop(zone, [pngFile('a.png'), pngFile('b.png')]);
    expect(within(zone).getByRole('alert').textContent).toBe('Drop one image at a time.');
    drop(zone, []);
    expect(within(zone).getByRole('alert').textContent).toBe('Drop an image file (JPEG, PNG, or WebP).');
    expect(validateImageUpload).not.toHaveBeenCalled();
  });

  it('reports a storage failure next to the slot', async () => {
    upload.mockResolvedValue({ data: null, error: new Error('bucket unavailable') });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    renderEditor();
    const zone = screen.getByRole('group', { name: 'Option B image' });
    drop(zone, [pngFile()]);
    expect((await within(zone).findByRole('alert')).textContent).toBe('Image upload failed. Please try again.');
    expect(within(preview()).queryByRole('img')).toBeNull();
  });

  it('rejects oversized decoded images before re-encoding', async () => {
    globalThis.Image = class {
      width = 9000;
      height = 9000;
      set src(_value) { queueMicrotask(() => this.onload?.()); }
    };
    renderEditor();
    const zone = screen.getByRole('group', { name: 'Question image' });
    drop(zone, [pngFile()]);
    expect((await within(zone).findByRole('alert')).textContent).toMatch(/dimensions are too large/);
    expect(upload).not.toHaveBeenCalled();
  });

  it('keeps a keyboard-accessible picker button that opens the file input', async () => {
    const user = userEvent.setup({ delay: null });
    renderEditor();
    const zone = screen.getByRole('group', { name: 'Question image' });
    const input = zone.querySelector('input[type="file"]');
    expect(input.id).toBe('q-img-upload');
    expect(input.getAttribute('accept')).toBe('image/jpeg,image/png,image/webp');
    const click = vi.spyOn(input, 'click');
    const button = within(zone).getByRole('button', { name: 'Upload Question Image' });
    // The dialog focuses the prompt on open; wait for that before moving focus.
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Question Prompt' })));
    button.focus();
    expect(document.activeElement).toBe(button);
    await user.keyboard('{Enter}');
    expect(click).toHaveBeenCalled();

    // Choosing a file through the picker uses the same upload flow.
    await user.upload(input, pngFile('picked.png'));
    await waitFor(() => expect(upload).toHaveBeenCalledTimes(1));
  });

  it('disables every drop zone while an upload is in flight', async () => {
    let finishUpload;
    upload.mockImplementation(() => new Promise(resolve => { finishUpload = resolve; }));
    renderEditor();
    drop(screen.getByRole('group', { name: 'Question image' }), [pngFile()]);
    await waitFor(() => expect(upload).toHaveBeenCalledTimes(1));
    expect(screen.getByRole('group', { name: 'Question image' }).getAttribute('aria-busy')).toBe('true');
    expect(within(screen.getByRole('group', { name: 'Question image' })).getByRole('button', { name: 'Uploading...' }).disabled).toBe(true);
    expect(within(screen.getByRole('group', { name: 'Option A image' })).getByRole('button', { name: 'Add Image' }).disabled).toBe(true);
    expect(screen.getByRole('button', { name: 'Save Changes' }).disabled).toBe(true);

    drop(screen.getByRole('group', { name: 'Option A image' }), [pngFile()]);
    expect(validateImageUpload).toHaveBeenCalledTimes(1);

    await act(async () => finishUpload({ data: {}, error: null }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save Changes' }).disabled).toBe(false));
  });

  it('saves uploaded paths and removes superseded uploads', async () => {
    const user = userEvent.setup({ delay: null });
    const { onSave } = renderEditor({ ...baseQuestion, options: ['First equation of motion', 'Second law', 'Third law', 'Hooke law'] });
    const zone = screen.getByRole('group', { name: 'Question image' });
    drop(zone, [pngFile('first.png')]);
    await waitFor(() => expect(upload).toHaveBeenCalledTimes(1));
    await within(zone).findByRole('img', { name: 'Question' });
    drop(zone, [pngFile('second.png')]);
    await waitFor(() => expect(upload).toHaveBeenCalledTimes(2));
    const [firstPath] = upload.mock.calls[0];
    const [secondPath] = upload.mock.calls[1];
    await waitFor(() => expect(within(zone).getByRole('img', { name: 'Question' }).getAttribute('src')).toBe(`signed:${secondPath}`));

    await user.click(screen.getByRole('button', { name: 'Save Changes' }));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(customAlert).not.toHaveBeenCalled();
    expect(remove).toHaveBeenCalledWith([firstPath]);
    expect(onSave.mock.calls[0][0].questionImageUrl).toBe(secondPath);
  });
});
