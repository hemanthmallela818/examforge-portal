import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const storageBucket = {
  upload: vi.fn(),
  remove: vi.fn(),
  getPublicUrl: vi.fn(path => ({ data: { publicUrl: `https://project.supabase.co/storage/v1/object/public/branding/${path}` } }))
};

vi.mock('../../../src/supabase', () => ({
  supabase: {
    rpc: vi.fn(),
    storage: { from: vi.fn(() => storageBucket) }
  }
}));
vi.mock('../../../src/utils', () => ({ customConfirm: vi.fn() }));
vi.mock('../../../src/branding/logoProcessing', () => ({
  LOGO_ACCEPT: 'image/png,image/jpeg,image/webp',
  validateLogoFile: vi.fn(),
  reencodeLogo: vi.fn(),
  logoObjectName: vi.fn(() => 'logo-0f8fad5b-d9cb-469f-a165-70867728950e.png')
}));

const { supabase } = await import('../../../src/supabase');
const { customConfirm } = await import('../../../src/utils');
const { validateLogoFile, reencodeLogo } = await import('../../../src/branding/logoProcessing');
const { setBranding, DEFAULT_BRANDING, BRANDING_CACHE_KEY } = await import('../../../src/branding/brandingStore');
const { default: SettingsView } = await import('../../../src/features/admin/settings/SettingsView');

const NEW_LOGO = 'logo-0f8fad5b-d9cb-469f-a165-70867728950e.png';
const OLD_LOGO = 'logo-7c9e6679-7425-40de-944b-e07fc1f90ae7.webp';

const serverRow = (overrides = {}) => ({
  institution_name: 'Sunrise Public School',
  primary_color: '#0f766e',
  logo_path: null,
  logo_url: null,
  updated_at: '2026-09-25T10:00:00Z',
  ...overrides
});

let user;
beforeEach(() => {
  user = userEvent.setup({ delay: null });
  sessionStorage.clear();
  act(() => { setBranding(DEFAULT_BRANDING); });
  vi.mocked(supabase.rpc).mockReset().mockImplementation(async (name) => (
    name === 'get_public_branding' ? { data: null, error: null } : { data: serverRow(), error: null }
  ));
  storageBucket.upload.mockReset().mockResolvedValue({ data: { path: NEW_LOGO }, error: null });
  storageBucket.remove.mockReset().mockResolvedValue({ data: [], error: null });
  vi.mocked(customConfirm).mockReset();
  vi.mocked(validateLogoFile).mockReset();
  vi.mocked(reencodeLogo).mockReset();
  globalThis.URL.createObjectURL = vi.fn(() => 'blob:logo-preview');
  globalThis.URL.revokeObjectURL = vi.fn();
});

const renderRoot = async () => {
  render(<SettingsView isRootDeveloper />);
  await waitFor(() => expect(supabase.rpc).toHaveBeenCalledWith('get_public_branding'));
  return screen.getByRole('region', { name: 'Branding' });
};

describe('Settings access', () => {
  it('shows a notice and loads nothing for a non-root administrator', () => {
    render(<SettingsView isRootDeveloper={false} />);
    expect(screen.getByRole('alert').textContent).toMatch(/root developer only/);
    expect(screen.queryByRole('region', { name: 'Branding' })).toBeNull();
    expect(supabase.rpc).not.toHaveBeenCalled();
  });
});

describe('Branding form', () => {
  it('validates the hex colour and disables Save while it is invalid', async () => {
    await renderRoot();
    const hex = screen.getByLabelText('Primary colour');
    await user.type(hex, '#12zz');
    expect(screen.getByText(/Enter a colour as #RRGGBB/)).toBeTruthy();
    expect(hex.getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByRole('button', { name: 'Save branding' }).disabled).toBe(true);
  });

  it('warns when the colour fails WCAG AA and passes for a dark colour', async () => {
    await renderRoot();
    const hex = screen.getByLabelText('Primary colour');
    await user.type(hex, '#facc15');
    expect(screen.getByText(/does not meet WCAG AA contrast/)).toBeTruthy();
    expect(screen.getAllByText('Below AA').length).toBeGreaterThan(0);

    await user.clear(hex);
    await user.type(hex, '#0f766e');
    expect(screen.queryByText(/does not meet WCAG AA contrast/)).toBeNull();
    // The live preview uses the derived scale.
    expect(screen.getByTestId('branding-preview').style.getPropertyValue('--brand-600')).toBe('#0f766e');
  });

  it('saves the normalised name and colour, then applies and caches the branding', async () => {
    await renderRoot();
    await user.type(screen.getByLabelText('Institution name'), '  Sunrise   Public School ');
    await user.type(screen.getByLabelText('Primary colour'), '#0F766E');
    await user.click(screen.getByRole('button', { name: 'Save branding' }));

    await waitFor(() => expect(supabase.rpc).toHaveBeenCalledWith('root_update_branding', {
      institution_name_param: 'Sunrise Public School',
      primary_color_param: '#0f766e',
      logo_path_param: null
    }));
    expect(await screen.findByText(/Branding saved/)).toBeTruthy();
    expect(document.documentElement.style.getPropertyValue('--brand-600')).toBe('#0f766e');
    expect(JSON.parse(sessionStorage.getItem(BRANDING_CACHE_KEY)).institutionName).toBe('Sunrise Public School');
    expect(storageBucket.upload).not.toHaveBeenCalled();
  });

  it('rejects an invalid logo without uploading', async () => {
    vi.mocked(validateLogoFile).mockResolvedValue({ valid: false, error: 'SVG logos are not accepted. Upload a PNG, JPEG or WebP image.' });
    await renderRoot();
    const input = screen.getByLabelText('Logo');
    fireEvent.change(input, { target: { files: [new File(['<svg/>'], 'logo.svg', { type: 'image/svg+xml' })] } });
    expect(await screen.findByText(/SVG logos are not accepted/)).toBeTruthy();
    expect(reencodeLogo).not.toHaveBeenCalled();
  });

  it('uploads a re-encoded logo, saves its path and removes the replaced logo', async () => {
    act(() => { setBranding({ ...serverRow({ logo_path: OLD_LOGO }), logoUrl: 'https://project.supabase.co/old.webp' }); });
    vi.mocked(supabase.rpc).mockImplementation(async (name) => (
      name === 'get_public_branding'
        ? { data: serverRow({ logo_path: OLD_LOGO }), error: null }
        : { data: serverRow({ logo_path: NEW_LOGO, updated_at: '2026-09-25T11:00:00Z' }), error: null }
    ));
    const blob = new Blob(['png'], { type: 'image/png' });
    vi.mocked(validateLogoFile).mockResolvedValue({ valid: true, width: 400, height: 200 });
    vi.mocked(reencodeLogo).mockResolvedValue({ blob, type: 'image/png', extension: 'png' });

    await renderRoot();
    fireEvent.change(screen.getByLabelText('Logo'), { target: { files: [new File(['x'], 'crest.jpg', { type: 'image/jpeg' })] } });
    await waitFor(() => expect(screen.getByAltText('Logo preview').getAttribute('src')).toBe('blob:logo-preview'));
    await user.click(screen.getByRole('button', { name: 'Save branding' }));

    await waitFor(() => expect(storageBucket.upload).toHaveBeenCalledWith(NEW_LOGO, blob, expect.objectContaining({ contentType: 'image/png', upsert: false })));
    expect(supabase.storage.from).toHaveBeenCalledWith('branding');
    await waitFor(() => expect(supabase.rpc).toHaveBeenCalledWith('root_update_branding', {
      institution_name_param: 'Sunrise Public School',
      primary_color_param: '#0f766e',
      logo_path_param: NEW_LOGO
    }));
    await waitFor(() => expect(storageBucket.remove).toHaveBeenCalledWith([OLD_LOGO]));
  });

  it('shows the server refusal and deletes the just-uploaded logo when saving fails', async () => {
    const blob = new Blob(['png'], { type: 'image/png' });
    vi.mocked(validateLogoFile).mockResolvedValue({ valid: true, width: 10, height: 10 });
    vi.mocked(reencodeLogo).mockResolvedValue({ blob, type: 'image/png', extension: 'png' });
    vi.mocked(supabase.rpc).mockImplementation(async (name) => (
      name === 'get_public_branding' ? { data: null, error: null } : { data: null, error: { code: '42501', message: 'Root developer access is required' } }
    ));
    await renderRoot();
    fireEvent.change(screen.getByLabelText('Logo'), { target: { files: [new File(['x'], 'crest.png', { type: 'image/png' })] } });
    await waitFor(() => expect(screen.getByAltText('Logo preview')).toBeTruthy());
    await user.click(screen.getByRole('button', { name: 'Save branding' }));
    expect(await screen.findByText('Only the root developer can change the branding.')).toBeTruthy();
    await waitFor(() => expect(storageBucket.remove).toHaveBeenCalledWith([NEW_LOGO]));
  });

  it('resets to defaults after confirmation', async () => {
    vi.mocked(customConfirm).mockResolvedValue(true);
    vi.mocked(supabase.rpc).mockImplementation(async (name) => (
      name === 'get_public_branding'
        ? { data: serverRow(), error: null }
        : { data: serverRow({ institution_name: null, primary_color: null, updated_at: '2026-09-25T12:00:00Z' }), error: null }
    ));
    await renderRoot();
    await waitFor(() => expect(screen.getByLabelText('Institution name').value).toBe('Sunrise Public School'));
    await user.click(screen.getByRole('button', { name: 'Reset to defaults' }));
    await waitFor(() => expect(supabase.rpc).toHaveBeenCalledWith('root_update_branding', {
      institution_name_param: null,
      primary_color_param: null,
      logo_path_param: null
    }));
    expect(await screen.findByText(/reset to the ExamForge defaults/)).toBeTruthy();
    expect(document.documentElement.style.getPropertyValue('--brand-600')).toBe('');
  });

  it('does nothing when the reset is cancelled', async () => {
    vi.mocked(customConfirm).mockResolvedValue(false);
    await renderRoot();
    await user.click(screen.getByRole('button', { name: 'Reset to defaults' }));
    expect(supabase.rpc).not.toHaveBeenCalledWith('root_update_branding', expect.anything());
  });
});
