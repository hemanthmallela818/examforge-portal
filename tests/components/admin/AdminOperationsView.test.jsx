import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import AdminOperationsView from '../../../src/components/AdminOperationsView';

describe('AdminOperationsView component', () => {
  const dummyHealth = {
    status: 'HEALTHY',
    checked_at: new Date().toISOString(),
    active_exams: 2,
    live_sessions: 5,
    expired_sessions_pending_finalization: 0,
    questions_missing_required_media: 0,
    inactive_students: 1,
    audit_events_last_24_hours: 12,
    scheduler: { available: true, healthy: true, scheduled: true }
  };

  const terminatedRows = [
    {
      session_id: 'stu1_exam1',
      student_id: 'STU-001',
      student_name: 'Rahul Sharma',
      exam_id: 'exam1',
      exam_title: 'JEE Advanced Physics',
      termination_reason: 'fullscreen',
      terminated_at: new Date(Date.now() - 1000 * 60 * 5).toISOString(),
      deadline_at: new Date(Date.now() + 1000 * 60 * 50).toISOString(),
      eligible: true,
      attempt_state: 'TERMINATED',
      access_generation: 1
    },
    {
      session_id: 'stu2_exam1',
      student_id: 'STU-002',
      student_name: 'Priya Patel',
      exam_id: 'exam1',
      exam_title: 'JEE Advanced Physics',
      termination_reason: 'escape',
      terminated_at: new Date(Date.now() - 1000 * 60 * 60).toISOString(),
      deadline_at: new Date(Date.now() - 1000 * 60 * 10).toISOString(),
      eligible: false,
      attempt_state: 'TERMINATED',
      access_generation: 1
    },
    {
      session_id: 'stu3_exam2',
      student_id: 'STU-003',
      student_name: 'Amit Kumar',
      exam_id: 'exam2',
      exam_title: 'Chemistry Mock',
      termination_reason: 'tab',
      terminated_at: new Date(Date.now() - 1000 * 60 * 120).toISOString(),
      deadline_at: new Date(Date.now() - 1000 * 60 * 30).toISOString(),
      eligible: false,
      attempt_state: 'FINALIZED',
      access_generation: 0
    }
  ];

  it('renders terminated students with eligibility badges and handles re-grant', async () => {
    const user = userEvent.setup();
    const onRegrantAccess = vi.fn();
    const onPageChange = vi.fn();

    render(
      <AdminOperationsView
        operationalHealth={dummyHealth}
        operationalLoading={false}
        operationalError=""
        onRefresh={vi.fn()}
        unreferencedAssets={[]}
        scanningAssets={false}
        cleaningAssets={false}
        onScanAssets={vi.fn()}
        onCleanupAssets={vi.fn()}
        auditEvents={[]}
        terminatedPage={{ rows: terminatedRows, total: 3, page: 1, pageSize: 10 }}
        terminatedLoading={false}
        regrantingSessionId={null}
        onRegrantAccess={onRegrantAccess}
        onPageChange={onPageChange}
      />
    );

    expect(screen.getByRole('heading', { name: /Terminated students/i })).toBeTruthy();
    expect(screen.getByText('Rahul Sharma')).toBeTruthy();
    expect(screen.getByText('STU-001')).toBeTruthy();
    expect(screen.getAllByText('JEE Advanced Physics')).toHaveLength(2);

    // Check status badges
    expect(screen.getByText('Eligible')).toBeTruthy();
    expect(screen.getByText('Expired')).toBeTruthy();
    expect(screen.getByText('Finalized')).toBeTruthy();

    // Re-grant buttons: Rahul is eligible, Priya is expired, Amit is finalized
    const regrantButtons = screen.getAllByRole('button', { name: /Re-grant Access/i });
    expect(regrantButtons).toHaveLength(3);

    expect(regrantButtons[0].disabled).toBe(false);
    expect(regrantButtons[1].disabled).toBe(true);
    expect(regrantButtons[2].disabled).toBe(true);

    // Clicking re-grant calls handler with session_id, student_name, exam_title
    await user.click(regrantButtons[0]);
    expect(onRegrantAccess).toHaveBeenCalledWith('stu1_exam1', 'Rahul Sharma', 'JEE Advanced Physics');
  });

  it('displays empty state when no terminated attempts exist', () => {
    render(
      <AdminOperationsView
        operationalHealth={dummyHealth}
        operationalLoading={false}
        operationalError=""
        onRefresh={vi.fn()}
        unreferencedAssets={null}
        scanningAssets={false}
        cleaningAssets={false}
        onScanAssets={vi.fn()}
        onCleanupAssets={vi.fn()}
        auditEvents={[]}
        terminatedPage={{ rows: [], total: 0, page: 1, pageSize: 10 }}
        terminatedLoading={false}
      />
    );

    expect(screen.getByText('No terminated student attempts')).toBeTruthy();
  });
});
