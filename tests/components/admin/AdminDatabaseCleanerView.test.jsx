import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import AdminDatabaseCleanerView from '../../../src/components/AdminDatabaseCleanerView';

describe('AdminDatabaseCleanerView component', () => {
  const dummyCounts = {
    cbt_exams: 5,
    active_sessions: 2,
    student_results: 15,
    question_bank: 120,
    students: 40,
    classes: 4,
    import_history: 3
  };

  it('renders Public-table storage (MB) as a two-decimal float and explains space retention', () => {
    // 5242880 bytes = exactly 5.00 MB
    render(
      <AdminDatabaseCleanerView
        dbSize={5242880}
        formatBytes={vi.fn()}
        tableCounts={dummyCounts}
        onMaintainTable={vi.fn()}
        isRootDeveloper={false}
        onResetApplication={vi.fn()}
        isResetting={false}
      />
    );

    expect(screen.getByText('Public-table storage (MB)')).toBeTruthy();
    expect(screen.getByText('5.00')).toBeTruthy();
    expect(screen.getByText(/reusable PostgreSQL space keep this number above zero/i)).toBeTruthy();
  });

  it('renders Clear Exam Data card for root developer and hides it for normal admins', async () => {
    const user = userEvent.setup();
    const onReset = vi.fn();

    // 1. Root developer view
    const { unmount } = render(
      <AdminDatabaseCleanerView
        dbSize={10485760}
        formatBytes={vi.fn()}
        tableCounts={dummyCounts}
        onMaintainTable={vi.fn()}
        isRootDeveloper={true}
        onResetApplication={onReset}
        isResetting={false}
      />
    );

    expect(screen.getByRole('heading', { name: /Clear Exam Data \(Root Developer Only\)/i })).toBeTruthy();
    expect(screen.getByText(/CLEAR EXAM DATA/)).toBeTruthy();
    const clearButton = screen.getByRole('button', { name: /Clear Exam Data/i });
    expect(clearButton).toBeTruthy();

    await user.click(clearButton);
    expect(onReset).toHaveBeenCalledTimes(1);

    unmount();

    // 2. Non-root developer view
    render(
      <AdminDatabaseCleanerView
        dbSize={10485760}
        formatBytes={vi.fn()}
        tableCounts={dummyCounts}
        onMaintainTable={vi.fn()}
        isRootDeveloper={false}
        onResetApplication={onReset}
        isResetting={false}
      />
    );

    expect(screen.queryByRole('heading', { name: /Clear Exam Data \(Root Developer Only\)/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /Clear Exam Data/i })).toBeNull();
  });
});
