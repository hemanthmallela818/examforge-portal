import React from 'react';
import { Download, Eye, FileText, Inbox, Loader2, Lock, Search, Trophy } from 'lucide-react';
import {
  Alert, Badge, Button, Card, CardContent, CardHeader, CardTitle, EmptyState, Input, Table, TBody, TD, TH, THead, TR, cn
} from '../../../components/ui';
import { useAdminContext } from '../adminContext';
import { RESULT_PAGE_SIZE } from '../adminConstants';
import { PagerButtons, pagerNavClass } from '../shared/AdminUi';

/** @type {Record<number, string | undefined>} */
const RANK_STYLES = {
  1: 'bg-amber-100 text-amber-800 ring-amber-300',
  2: 'bg-slate-100 text-slate-700 ring-slate-300',
  3: 'bg-orange-100 text-orange-800 ring-orange-300'
};

/**
 * Leaderboard rank: tinted gold / silver / bronze circles for the podium, plain number otherwise.
 * @param {{ rank: number }} props
 */
const RankBadge = ({ rank }) => (
  RANK_STYLES[rank] ? (
    <span className={cn('inline-grid size-8 place-items-center rounded-full text-sm font-bold tabular-nums ring-1', RANK_STYLES[rank])}>
      <span className="sr-only">Rank </span>{rank}
    </span>
  ) : (
    <span className="text-sm font-semibold text-slate-500 tabular-nums">#{rank}</span>
  )
);

/**
 * @typedef {object} ExamLeaderboardProps
 * @property {import('./useExamDetail').ExamDetailRecord} exam
 * @property {ReturnType<typeof import('./useExamDetail').useExamDetail>} examDetail
 * @property {ReturnType<typeof import('./useResultExports').useResultExports>} resultExports
 */

/**
 * Paged, searchable leaderboard with audited CSV/PDF exports and per-student answer review.
 * @param {ExamLeaderboardProps} props
 */
export default function ExamLeaderboard({ exam, examDetail, resultExports }) {
  const { dataLoadState } = useAdminContext();
  const {
    studentResults,
    resultSubjects,
    resultSnapshot,
    resultPage,
    setResultPage,
    resultSearch,
    setResultSearch,
    resultSearchInput,
    setResultSearchInput,
    resultPageTotal,
    resultOverallCount,
    resultReviewLoadingId,
    openStudentResultReview,
    fetchResults
  } = examDetail;
  const { isDownloadingCSV, isDownloadingPDF, downloadLeaderboardCsv, downloadLeaderboardPDF } = resultExports;

  const rankedResults = studentResults;
  const examSubjects = /** @type {string[]} */ (resultSubjects.length > 0 ? resultSubjects : (exam.questionsData?.subjects || []));
  const resultCollectionState = /** @type {Partial<import('../../../types').DataLoadEntry>} */ (dataLoadState.results || {});
  const resultQueryChanged = resultSnapshot.examId !== exam.id || resultSnapshot.page !== resultPage || resultSnapshot.search !== resultSearch;
  const resultActionsDisabled = resultQueryChanged || Boolean(resultCollectionState.loading || resultCollectionState.error);
  const exportUnavailable = Boolean(resultOverallCount === 0 || resultCollectionState.loading || resultCollectionState.error || isDownloadingCSV || isDownloadingPDF);
  const totalResultPages = Math.max(1, Math.ceil(resultPageTotal / RESULT_PAGE_SIZE));
  const confirmedResultFirst = resultPageTotal === 0 ? 0 : (resultSnapshot.page * RESULT_PAGE_SIZE) + 1;
  const confirmedResultLast = resultPageTotal === 0 ? 0 : Math.min(resultPageTotal, confirmedResultFirst + rankedResults.length - 1);
  const applyResultSearch = () => {
    const nextSearch = resultSearchInput.trim();
    setResultPage(0);
    if (nextSearch === resultSearch && resultPage === 0) fetchResults(exam.id);
    else setResultSearch(nextSearch);
  };

  return (
    <Card className="flex flex-1 flex-col">
      <CardHeader className="items-center">
        <CardTitle><Trophy aria-hidden="true" /> {exam.title} - Leaderboard</CardTitle>
        <div className="flex flex-wrap items-center gap-2">
          {resultOverallCount > 0 && (
            <>
              <Button
                variant="success"
                size="sm"
                onClick={() => downloadLeaderboardCsv(exam.id, resultOverallCount, exam.title)}
                disabled={exportUnavailable}
                title={exportUnavailable ? 'Wait for a complete, valid result list before exporting.' : 'Download UTF-8 CSV'}
              >
                {isDownloadingCSV ? <Loader2 className="animate-spin" aria-hidden="true" /> : <Download aria-hidden="true" />}
                {isDownloadingCSV ? 'Preparing CSV…' : 'Download CSV'}
              </Button>
              <Button
                size="sm"
                onClick={() => downloadLeaderboardPDF(exam.id, resultOverallCount, exam.title)}
                disabled={isDownloadingPDF || exportUnavailable}
                aria-busy={isDownloadingPDF}
                title={exportUnavailable ? 'Wait for a complete, valid result list before exporting.' : 'Download printable PDF'}
              >
                {isDownloadingPDF ? <Loader2 className="animate-spin" aria-hidden="true" /> : <FileText aria-hidden="true" />}
                {isDownloadingPDF ? 'Generating PDF...' : 'Download PDF'}
              </Button>
            </>
          )}
          <Badge variant="neutral" className="py-1">
            <Lock aria-hidden="true" /> Results retained
          </Badge>
        </div>
      </CardHeader>

      <CardContent className="flex flex-1 flex-col gap-4">
        <div className="flex flex-wrap gap-2">
          <div className="relative min-w-[220px] flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-slate-400" aria-hidden="true" />
            <Input type="search" aria-label="Search leaderboard by student name or ID" placeholder="Student name or ID" maxLength={100} value={resultSearchInput} disabled={resultCollectionState.loading} onChange={event => setResultSearchInput(event.target.value)} onKeyDown={event => {
              if (event.key === 'Enter') { event.preventDefault(); applyResultSearch(); }
            }} className="pl-9" />
          </div>
          <Button variant="secondary" disabled={resultCollectionState.loading} onClick={applyResultSearch}>Search</Button>
          {(resultSearch || resultSearchInput) && <Button variant="ghost" disabled={resultCollectionState.loading} onClick={() => {
            setResultSearchInput('');
            setResultSearch('');
            setResultPage(0);
          }}>Clear search</Button>}
        </div>
        <div role="status" className="flex flex-wrap justify-between gap-3 text-sm text-slate-500">
          <span>Showing confirmed results {confirmedResultFirst}-{confirmedResultLast} of {resultPageTotal.toLocaleString()} matching result(s); {resultOverallCount.toLocaleString()} total submission(s).</span>
          {(resultCollectionState.loading || resultQueryChanged) && <span>Loading requested leaderboard page…</span>}
        </div>
        {resultCollectionState.error && (
          <Alert variant="danger" role="alert">
            {resultCollectionState.error} {resultQueryChanged ? 'The table below is the last confirmed page and its navigation is disabled.' : ''}
          </Alert>
        )}

        {rankedResults.length === 0 ? (
          <EmptyState
            icon={Inbox}
            className="flex-1"
            title={resultOverallCount === 0 ? 'No submissions yet for this exam.' : 'No results match this search.'}
          />
        ) : (
          <Table>
            <THead>
              <tr>
                <TH className="w-20 text-center">Rank</TH>
                <TH>Student Name</TH>
                <TH>Student ID</TH>
                {examSubjects.map(sub => (
                  <React.Fragment key={sub}>
                    <TH className="text-center">{sub} Marks</TH>
                    <TH className="text-center">{sub} Rank</TH>
                  </React.Fragment>
                ))}
                <TH className="text-right">Total Score</TH>
                <TH className="text-center">Answer Review</TH>
              </tr>
            </THead>
            <TBody>
              {rankedResults.map((result) => (
                <TR key={result.studentId} className={cn(result.totalRank === 1 && 'bg-amber-50/50 hover:bg-amber-50')}>
                  <TD className="text-center">
                    <RankBadge rank={result.totalRank} />
                  </TD>
                  <TD className="font-semibold text-slate-900">{result.studentName}</TD>
                  <TD className="font-mono text-[13px] text-slate-500">{result.studentId}</TD>
                  {examSubjects.map(sub => {
                    const score = /** @type {number} */ (result.subjectScores?.[sub] ?? 0);
                    const sRank = result.subjectRanks?.[sub] ?? 'N/A';
                    return (
                      <React.Fragment key={sub}>
                        <TD className="text-center tabular-nums">{score}</TD>
                        <TD className="text-center font-medium text-brand-700 tabular-nums">
                          {sRank !== 'N/A' ? `#${sRank}` : 'N/A'}
                        </TD>
                      </React.Fragment>
                    );
                  })}
                  <TD className="whitespace-nowrap text-right tabular-nums">
                    <span className="text-base font-bold text-brand-700">{result.totalScore}</span> <span className="text-sm text-slate-500">/ {result.maxScore}</span>
                  </TD>
                  <TD className="text-center">
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={resultReviewLoadingId === result.id}
                      onClick={() => openStudentResultReview(result)}
                    >
                      {resultReviewLoadingId === result.id ? <Loader2 className="animate-spin" aria-hidden="true" /> : <Eye aria-hidden="true" />}
                      {resultReviewLoadingId === result.id ? 'Loading…' : 'Reveal answers'}
                    </Button>
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
        <nav aria-label="Leaderboard pages" className={pagerNavClass}>
          <PagerButtons
            page={resultPage + 1}
            totalPages={totalResultPages}
            prevDisabled={resultPage <= 0 || resultActionsDisabled}
            nextDisabled={resultPage + 1 >= totalResultPages || resultActionsDisabled}
            onPrev={() => setResultPage(page => Math.max(0, page - 1))}
            onNext={() => setResultPage(page => Math.min(totalResultPages - 1, page + 1))}
          />
        </nav>
      </CardContent>
    </Card>
  );
}
