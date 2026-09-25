import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AdminContext } from '../../../src/features/admin/adminContext';
import ExamLeaderboard from '../../../src/features/admin/exams/ExamLeaderboard';

const exam = { id: 'exam-1', title: 'Mock Test 1', questionsData: { subjects: ['Physics', 'Chemistry'] } };

const makeResult = (rank, overrides = {}) => ({
  id: `r${rank}`,
  studentId: `S00${rank}`,
  studentName: `Student ${rank}`,
  totalScore: 100 - rank,
  maxScore: 120,
  totalRank: rank,
  subjectScores: { Physics: 50 - rank, Chemistry: 50 },
  subjectRanks: { Physics: rank },
  ...overrides
});

const makeExamDetail = (overrides = {}) => ({
  studentResults: [1, 2, 3, 4].map(rank => makeResult(rank)),
  resultSubjects: [],
  resultSnapshot: { examId: 'exam-1', page: 0, search: '' },
  resultPage: 0,
  setResultPage: vi.fn(),
  resultSearch: '',
  setResultSearch: vi.fn(),
  resultSearchInput: '',
  setResultSearchInput: vi.fn(),
  resultPageTotal: 4,
  resultOverallCount: 4,
  resultReviewLoadingId: null,
  openStudentResultReview: vi.fn(),
  fetchResults: vi.fn(),
  ...overrides
});

const makeExports = (overrides = {}) => ({
  isDownloadingCSV: false,
  isDownloadingPDF: false,
  downloadLeaderboardCsv: vi.fn(),
  downloadLeaderboardPDF: vi.fn(),
  ...overrides
});

const renderBoard = ({ examDetail = makeExamDetail(), resultExports = makeExports(), dataLoadState = {} } = {}) => {
  render(
    <AdminContext.Provider value={{ dataLoadState }}>
      <ExamLeaderboard exam={exam} examDetail={examDetail} resultExports={resultExports} />
    </AdminContext.Provider>
  );
  return { examDetail, resultExports };
};

const csvButton = () => screen.getByRole('button', { name: /CSV/ });
const pdfButton = () => screen.getByRole('button', { name: /PDF/ });

describe('ExamLeaderboard ranks', () => {
  it('renders podium badges for ranks 1-3 and plain numbers otherwise', () => {
    renderBoard();
    const rows = screen.getAllByRole('row').slice(1);
    expect(rows).toHaveLength(4);
    const firstCells = rows.map(row => within(row).getAllByRole('cell')[0]);
    expect(firstCells[0].textContent).toBe('Rank 1');
    expect(within(firstCells[0]).getByText('Rank').className).toContain('sr-only');
    expect(firstCells[0].firstElementChild.className).toContain('amber');
    expect(firstCells[1].firstElementChild.className).toContain('slate');
    expect(firstCells[2].firstElementChild.className).toContain('orange');
    expect(firstCells[3].textContent).toBe('#4');
    expect(rows[0].className).toContain('bg-amber-50');
  });

  it('shows per-subject marks and ranks with N/A for missing subject ranks', () => {
    renderBoard();
    expect(screen.getByRole('columnheader', { name: 'Physics Marks' })).toBeTruthy();
    expect(screen.getByRole('columnheader', { name: 'Chemistry Rank' })).toBeTruthy();
    const firstRow = screen.getAllByRole('row')[1];
    const cells = within(firstRow).getAllByRole('cell').map(cell => cell.textContent);
    expect(cells).toEqual(['Rank 1', 'Student 1', 'S001', '49', '#1', '50', 'N/A', '99 / 120', 'Reveal answers']);
  });

  it('prefers the server result subjects over the exam paper subjects', () => {
    renderBoard({ examDetail: makeExamDetail({ resultSubjects: ['Maths'] }) });
    expect(screen.getByRole('columnheader', { name: 'Maths Marks' })).toBeTruthy();
    expect(screen.queryByRole('columnheader', { name: 'Physics Marks' })).toBeNull();
  });

  it('opens the answer review and shows the loading state for that row only', async () => {
    const user = userEvent.setup({ delay: null });
    const { examDetail } = renderBoard({ examDetail: makeExamDetail({ resultReviewLoadingId: 'r2' }) });
    const buttons = screen.getAllByRole('button', { name: /Reveal answers|Loading…/ });
    expect(buttons[1].textContent).toBe('Loading…');
    expect(buttons[1].disabled).toBe(true);
    await user.click(buttons[0]);
    expect(examDetail.openStudentResultReview).toHaveBeenCalledWith(expect.objectContaining({ id: 'r1' }));
  });

  it('shows the empty state without export buttons when there are no submissions', () => {
    renderBoard({ examDetail: makeExamDetail({ studentResults: [], resultPageTotal: 0, resultOverallCount: 0 }) });
    expect(screen.getByText('No submissions yet for this exam.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /CSV/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /PDF/ })).toBeNull();
    expect(screen.getByText(/Showing confirmed results 0-0 of 0/)).toBeTruthy();
  });

  it('distinguishes "no search matches" from "no submissions"', () => {
    renderBoard({ examDetail: makeExamDetail({ studentResults: [], resultPageTotal: 0, resultOverallCount: 4 }) });
    expect(screen.getByText('No results match this search.')).toBeTruthy();
  });
});

describe('ExamLeaderboard exports', () => {
  it('enables both exports for a complete result list and passes the overall count', async () => {
    const user = userEvent.setup({ delay: null });
    const { resultExports } = renderBoard();
    expect(csvButton().disabled).toBe(false);
    expect(pdfButton().disabled).toBe(false);
    expect(csvButton().title).toBe('Download UTF-8 CSV');
    await user.click(csvButton());
    await user.click(pdfButton());
    expect(resultExports.downloadLeaderboardCsv).toHaveBeenCalledWith('exam-1', 4, 'Mock Test 1');
    expect(resultExports.downloadLeaderboardPDF).toHaveBeenCalledWith('exam-1', 4, 'Mock Test 1');
  });

  it.each([
    ['while results load', { dataLoadState: { results: { loading: true, error: '' } } }],
    ['after a load error', { dataLoadState: { results: { loading: false, error: 'Results could not be loaded.' } } }]
  ])('disables both exports %s', (_label, options) => {
    renderBoard(options);
    expect(csvButton().disabled).toBe(true);
    expect(pdfButton().disabled).toBe(true);
    expect(csvButton().title).toBe('Wait for a complete, valid result list before exporting.');
  });

  it('disables both exports and shows progress while a CSV is being prepared', () => {
    renderBoard({ resultExports: makeExports({ isDownloadingCSV: true }) });
    expect(csvButton().textContent).toBe('Preparing CSV…');
    expect(csvButton().disabled).toBe(true);
    expect(pdfButton().disabled).toBe(true);
  });

  it('marks the PDF button busy while a PDF is generated', () => {
    renderBoard({ resultExports: makeExports({ isDownloadingPDF: true }) });
    expect(pdfButton().textContent).toBe('Generating PDF...');
    expect(pdfButton().getAttribute('aria-busy')).toBe('true');
    expect(csvButton().disabled).toBe(true);
  });

  it('shows the load error and disables paging when the requested page differs from the confirmed one', () => {
    renderBoard({
      examDetail: makeExamDetail({ resultPage: 1, resultPageTotal: 250 }),
      dataLoadState: { results: { loading: false, error: 'Results could not be loaded.' } }
    });
    expect(screen.getByRole('alert').textContent).toContain('The table below is the last confirmed page');
    const nav = screen.getByRole('navigation', { name: 'Leaderboard pages' });
    expect(within(nav).getByRole('button', { name: /Previous/ }).disabled).toBe(true);
    expect(within(nav).getByRole('button', { name: /Next/ }).disabled).toBe(true);
    expect(within(nav).getByText('Page 2 of 3')).toBeTruthy();
  });
});
