import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const { THEME_STORAGE_KEY, disposeTheme, initTheme, setThemePreference, resolveTheme, normalizeThemePreference } = await import('../../../src/theme/theme');
const { default: ThemeToggle } = await import('../../../src/theme/ThemeToggle');
const { default: AdminProfileMenu } = await import('../../../src/features/admin/AdminProfileMenu');

/** Controllable prefers-color-scheme media query. */
const installMatchMedia = (initiallyDark) => {
  const listeners = new Set();
  const query = {
    matches: initiallyDark,
    media: '(prefers-color-scheme: dark)',
    addEventListener: vi.fn((_type, listener) => listeners.add(listener)),
    removeEventListener: vi.fn((_type, listener) => listeners.delete(listener))
  };
  window.matchMedia = vi.fn(() => query);
  return {
    setDark(value) {
      query.matches = value;
      listeners.forEach(listener => listener({ matches: value }));
    }
  };
};

const root = () => document.documentElement;
let user;

beforeEach(() => {
  user = userEvent.setup({ delay: null });
  localStorage.clear();
  root().classList.remove('dark');
  delete root().dataset.theme;
});

afterEach(() => {
  disposeTheme();
  delete window.matchMedia;
});

describe('theme preference', () => {
  it('normalises preferences and resolves System from the OS setting', () => {
    expect(normalizeThemePreference('dark')).toBe('dark');
    expect(normalizeThemePreference('neon')).toBe('system');
    expect(normalizeThemePreference(null)).toBe('system');
    expect(resolveTheme('system', true)).toBe('dark');
    expect(resolveTheme('system', false)).toBe('light');
    expect(resolveTheme('light', true)).toBe('light');
  });

  it('defaults to System, follows prefers-color-scheme live, and applies .dark before render', () => {
    const media = installMatchMedia(true);
    act(() => initTheme());
    expect(root().classList.contains('dark')).toBe(true);
    expect(root().dataset.theme).toBe('dark');
    expect(root().style.colorScheme).toBe('dark');

    act(() => media.setDark(false));
    expect(root().classList.contains('dark')).toBe(false);
    expect(root().dataset.theme).toBe('light');
  });

  it('restores a stored preference and persists changes per browser', () => {
    installMatchMedia(false);
    localStorage.setItem(THEME_STORAGE_KEY, 'dark');
    act(() => initTheme());
    expect(root().classList.contains('dark')).toBe(true);

    act(() => setThemePreference('light'));
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('light');
    expect(root().classList.contains('dark')).toBe(false);

    act(() => setThemePreference('bogus'));
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('system');
  });

  it('works without matchMedia or storage (treats System as light)', () => {
    act(() => initTheme());
    expect(root().dataset.theme).toBe('light');
  });
});

describe('ThemeToggle', () => {
  it('is a labelled radio group with aria-checked options', async () => {
    installMatchMedia(false);
    act(() => initTheme());
    render(<ThemeToggle />);
    const group = screen.getByRole('radiogroup', { name: 'Colour theme' });
    expect(group).toBeTruthy();
    const radios = screen.getAllByRole('radio');
    expect(radios.map(radio => radio.getAttribute('aria-label'))).toEqual(['Light', 'Dark', 'System']);
    expect(screen.getByRole('radio', { name: 'System' }).getAttribute('aria-checked')).toBe('true');
    // Roving tab stop on the checked option.
    expect(radios.map(radio => radio.tabIndex)).toEqual([-1, -1, 0]);

    await user.click(screen.getByRole('radio', { name: 'Dark' }));
    expect(screen.getByRole('radio', { name: 'Dark' }).getAttribute('aria-checked')).toBe('true');
    expect(root().classList.contains('dark')).toBe(true);
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');
  });

  it('moves the selection with arrow keys', () => {
    installMatchMedia(false);
    act(() => setThemePreference('light'));
    render(<ThemeToggle />);
    const light = screen.getByRole('radio', { name: 'Light' });
    fireEvent.keyDown(light, { key: 'ArrowRight' });
    expect(screen.getByRole('radio', { name: 'Dark' }).getAttribute('aria-checked')).toBe('true');
    expect(document.activeElement).toBe(screen.getByRole('radio', { name: 'Dark' }));
    fireEvent.keyDown(document.activeElement, { key: 'ArrowLeft' });
    fireEvent.keyDown(document.activeElement, { key: 'ArrowLeft' });
    expect(screen.getByRole('radio', { name: 'System' }).getAttribute('aria-checked')).toBe('true');
  });

  it('in buttons-only mode (exam) every option is tabbable and arrow keys are left alone', () => {
    installMatchMedia(false);
    act(() => setThemePreference('light'));
    const onWindowKeyDown = vi.fn();
    window.addEventListener('keydown', onWindowKeyDown);
    render(<ThemeToggle tone="inverse" arrowKeys={false} />);
    const radios = screen.getAllByRole('radio');
    expect(radios.map(radio => radio.tabIndex)).toEqual([0, 0, 0]);
    fireEvent.keyDown(radios[0], { key: 'ArrowRight' });
    expect(screen.getByRole('radio', { name: 'Light' }).getAttribute('aria-checked')).toBe('true');
    // The event still reaches the exam's own handlers (question navigation).
    expect(onWindowKeyDown).toHaveBeenCalledTimes(1);
    window.removeEventListener('keydown', onWindowKeyDown);
  });
});

describe('AdminProfileMenu', () => {
  it('opens a theme menu with menuitemradio options from the role chip', async () => {
    installMatchMedia(false);
    act(() => setThemePreference('system'));
    render(<AdminProfileMenu isRootDeveloper={false} />);
    const chip = screen.getByRole('button', { name: /Administrator/ });
    expect(chip.getAttribute('aria-expanded')).toBe('false');
    await user.click(chip);
    expect(chip.getAttribute('aria-expanded')).toBe('true');
    const menu = screen.getByRole('menu', { name: 'Administrator menu' });
    expect(menu).toBeTruthy();
    const items = screen.getAllByRole('menuitemradio');
    expect(items.map(item => item.textContent)).toEqual(['Light', 'Dark', 'System']);
    expect(screen.getByRole('menuitemradio', { name: 'System' }).getAttribute('aria-checked')).toBe('true');
    expect(document.activeElement).toBe(screen.getByRole('menuitemradio', { name: 'System' }));

    fireEvent.keyDown(document.activeElement, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(screen.getByRole('menuitemradio', { name: 'Dark' }));
    await user.click(screen.getByRole('menuitemradio', { name: 'Dark' }));
    expect(root().classList.contains('dark')).toBe(true);
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(chip);
  });

  it('closes on Escape and returns focus to the chip', async () => {
    installMatchMedia(false);
    render(<AdminProfileMenu isRootDeveloper />);
    const chip = screen.getByRole('button', { name: /Root Developer/ });
    await user.click(chip);
    fireEvent.keyDown(document.activeElement, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(chip);
  });
});
