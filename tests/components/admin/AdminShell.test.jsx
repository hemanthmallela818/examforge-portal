import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// Chainable query stub for RootAdministratorManager's managed_administrators/profiles reads.
const emptyQuery = () => {
  const builder = {
    select: () => builder,
    order: () => Promise.resolve({ data: [], error: null }),
    in: () => Promise.resolve({ data: [], error: null })
  };
  return builder;
};

vi.mock('../../../src/supabase', () => ({
  supabase: {
    from: vi.fn(),
    rpc: vi.fn(),
    functions: { invoke: vi.fn() },
    auth: { signOut: vi.fn() }
  }
}));

const { supabase } = await import('../../../src/supabase');
const { AdminContext } = await import('../../../src/features/admin/adminContext');
const { default: AdminShell } = await import('../../../src/features/admin/AdminShell');

const TAB_LABELS = [
  'Dashboard',
  'Students',
  'Classes',
  'Subjects & Patterns',
  'Question Bank',
  'Reviewed JSON Import',
  'Operations & Audit',
  'Database Cleaner'
];

let user;
beforeEach(() => {
  user = userEvent.setup({ delay: null });
  vi.mocked(supabase.from).mockReset().mockImplementation(emptyQuery);
  vi.mocked(supabase.auth.signOut).mockReset().mockResolvedValue({ error: null });
  sessionStorage.clear();
});

const renderShell = ({ isRootDeveloper = false, destructiveAction = null, ...props } = {}) => {
  const context = { isRootDeveloper, destructiveAction, setDestructiveAction: vi.fn() };
  const handlers = {
    activeTab: 'DASHBOARD',
    activeExamId: null,
    pageTitle: 'Overview',
    onNavigate: vi.fn(),
    onBackToLogin: vi.fn(),
    failedDataLoads: [],
    isAnyDataLoading: false,
    onRetryFailedDataLoads: vi.fn(),
    ...props
  };
  render(
    <AdminContext.Provider value={context}>
      <AdminShell {...handlers}><p>Screen body</p></AdminShell>
    </AdminContext.Provider>
  );
  return { ...handlers, context };
};

const sidebar = () => screen.getByRole('navigation', { name: 'Administrator sections' });

describe('AdminShell sidebar', () => {
  it('renders every section tab in order and the page title', () => {
    renderShell();
    expect(within(sidebar()).getAllByRole('button').map(button => button.textContent)).toEqual(TAB_LABELS);
    expect(screen.getByRole('heading', { level: 1, name: 'Overview' })).toBeTruthy();
    expect(screen.getByText('Screen body')).toBeTruthy();
  });

  it('marks only the active tab with aria-current="page"', () => {
    renderShell({ activeTab: 'CLASSES' });
    const current = within(sidebar()).getAllByRole('button').filter(button => button.getAttribute('aria-current') === 'page');
    expect(current.map(button => button.textContent)).toEqual(['Classes']);
  });

  it('shows an Exam Detail crumb (and un-highlights Dashboard) while an exam is open', () => {
    renderShell({ activeExamId: 'exam-1' });
    expect(within(sidebar()).getByText('Exam Detail').getAttribute('aria-current')).toBe('page');
    expect(within(sidebar()).getByRole('button', { name: 'Dashboard' }).getAttribute('aria-current')).toBeNull();
  });

  it('navigates to the clicked tab', async () => {
    const { onNavigate } = renderShell();
    await user.click(within(sidebar()).getByRole('button', { name: 'Question Bank' }));
    await user.click(within(sidebar()).getByRole('button', { name: 'Dashboard' }));
    expect(onNavigate.mock.calls).toEqual([[{ tab: 'QUESTION_BANK' }], [{ tab: 'DASHBOARD' }]]);
  });

  it('logs out locally and returns to the login screen', async () => {
    sessionStorage.setItem('currentAdmin', 'x');
    const { onBackToLogin } = renderShell();
    await user.click(screen.getByRole('button', { name: 'Logout' }));
    await waitFor(() => expect(onBackToLogin).toHaveBeenCalled());
    expect(supabase.auth.signOut).toHaveBeenCalledWith({ scope: 'local' });
    expect(sessionStorage.getItem('examState')).toBe('AUTH');
    expect(sessionStorage.getItem('currentAdmin')).toBeNull();
  });
});

describe('AdminShell root-only content', () => {
  it('hides the administrator manager and shows the Administrator chip for a non-root admin', () => {
    renderShell({ isRootDeveloper: false });
    expect(screen.getByText('Administrator')).toBeTruthy();
    expect(screen.queryByText('Root Developer')).toBeNull();
    expect(screen.queryByText('Root developer — Manage administrators')).toBeNull();
    expect(supabase.from).not.toHaveBeenCalled();
  });

  it('shows the administrator manager and Root Developer chip for the root developer', async () => {
    renderShell({ isRootDeveloper: true });
    expect(screen.getByText('Root Developer')).toBeTruthy();
    expect(screen.getByText('Root developer — Manage administrators')).toBeTruthy();
    await waitFor(() => expect(supabase.from).toHaveBeenCalledWith('managed_administrators'));
  });
});

describe('AdminShell data-load banner and dialog', () => {
  it('lists failed loads and retries them', async () => {
    const { onRetryFailedDataLoads } = renderShell({
      failedDataLoads: [['classes', { loading: false, error: 'Classes could not be loaded.' }]]
    });
    const alert = screen.getByRole('alert');
    expect(within(alert).getByText('Some administrator data could not be refreshed.')).toBeTruthy();
    expect(within(alert).getByText('Classes could not be loaded.')).toBeTruthy();
    await user.click(within(alert).getByRole('button', { name: 'Retry failed data' }));
    expect(onRetryFailedDataLoads).toHaveBeenCalled();
  });

  it('disables retry and announces while data is loading', () => {
    renderShell({ isAnyDataLoading: true, failedDataLoads: [['counts', { loading: true, error: 'Totals stale.' }]] });
    expect(screen.getByRole('button', { name: 'Retry failed data' }).disabled).toBe(true);
    expect(screen.getByText('Refreshing administrator data…').getAttribute('role')).toBe('status');
  });

  it('renders the destructive-action dialog from context', () => {
    renderShell({
      destructiveAction: {
        title: 'Clear Results',
        description: 'Removes all results.',
        impact: [{ label: 'Results', count: 3 }],
        preserved: ['students'],
        phrase: 'CLEAR RESULTS',
        confirmLabel: 'Clear Results',
        run: vi.fn()
      }
    });
    expect(screen.getByRole('dialog', { name: 'Clear Results' })).toBeTruthy();
  });
});
