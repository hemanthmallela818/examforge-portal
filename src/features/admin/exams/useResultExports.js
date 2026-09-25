import { useRef, useState } from 'react';
import { customAlert } from '../../../utils';
import { supabase } from '../../../supabase';
import {
  buildLeaderboardCsv,
  createLeaderboardPdfDocument,
  MAX_PDF_RESULT_ROWS,
  safeDownloadName,
  validatePdfExport
} from '../../../resultExportLogic';
import { parseResultExportPageResponse, validateCompleteResultExport } from '../../../resultPaging';
import { RESULT_EXPORT_PAGE_SIZE } from '../adminConstants';

/**
 * Audited, complete-or-nothing leaderboard CSV/PDF exports with duplicate-download suppression.
 * @param {{ fetchResults: (examId: string) => Promise<unknown> }} dependencies
 */
export function useResultExports({ fetchResults }) {
  const [isDownloadingCSV, setIsDownloadingCSV] = useState(false);
  const [isDownloadingPDF, setIsDownloadingPDF] = useState(false);
  const csvDownloadInFlight = useRef(false);
  const pdfDownloadInFlight = useRef(false);

  /**
   * @param {string} examId
   * @param {number} expectedCount
   */
  const loadCompleteResultsForExport = async (examId, expectedCount) => {
    if (!Number.isInteger(expectedCount) || expectedCount < 1 || expectedCount > 20000) {
      throw new Error('CSV export supports between 1 and 20,000 results.');
    }
    /** @type {import('../../../types').ExportResultRow[][]} */
    const pages = [];
    /** @type {string[] | null} */
    let subjects = null;
    const maximumPages = Math.ceil(expectedCount / RESULT_EXPORT_PAGE_SIZE);
    /** @type {string | null} */
    let afterCursor = null;
    for (let page = 0; page < maximumPages; page += 1) {
      const { data, error } = await supabase.rpc('get_admin_exam_results_export_page', {
        exam_id_param: examId,
        after_student_id_param: afterCursor,
        page_size_param: RESULT_EXPORT_PAGE_SIZE,
        expected_result_count_param: expectedCount
      });
      if (error) throw error;
      const parsed = parseResultExportPageResponse(data, { expectedCount, pageSize: RESULT_EXPORT_PAGE_SIZE, afterCursor });
      if (subjects === null) subjects = parsed.subjects;
      else if (JSON.stringify(subjects) !== JSON.stringify(parsed.subjects)) throw new Error('The examination subjects changed while the export was being prepared.');
      pages.push(parsed.rows);
      afterCursor = parsed.nextCursor;
      if (!parsed.hasMore) break;
      if (page === maximumPages - 1) throw new Error('The export returned more results than expected.');
    }
    return { results: validateCompleteResultExport(pages, expectedCount), subjects: subjects || [] };
  };

  /**
   * @param {string} examId
   * @param {'CSV' | 'PDF'} format
   * @param {number} resultCount
   */
  const authorizeResultExport = async (examId, format, resultCount) => {
    const { data, error } = await supabase.rpc('record_result_export', {
      exam_id_param: examId,
      export_format_param: format,
      expected_result_count_param: resultCount
    });
    if (error || !data?.authorized || Number(data.result_count) !== resultCount) {
      const message = error?.message || 'The server did not authorize this export.';
      if (/result set changed/i.test(message)) await fetchResults(examId);
      await customAlert(`Export blocked: ${message}`);
      return false;
    }
    return true;
  };

  /**
   * @param {string} examId
   * @param {number} expectedCount
   * @param {string} examTitle
   */
  const downloadLeaderboardCsv = async (examId, expectedCount, examTitle) => {
    if (csvDownloadInFlight.current) return;
    csvDownloadInFlight.current = true;
    setIsDownloadingCSV(true);
    try {
      const { results, subjects } = await loadCompleteResultsForExport(examId, expectedCount);
      const csvContent = buildLeaderboardCsv(results, subjects);
      if (!await authorizeResultExport(examId, 'CSV', results.length)) return;
      const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8' });
      const encodedUri = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.setAttribute('href', encodedUri);
      link.setAttribute('download', `${safeDownloadName(examTitle)}_Leaderboard.csv`);
      document.body.appendChild(link);
      try {
        link.click();
      } finally {
        document.body.removeChild(link);
        URL.revokeObjectURL(encodedUri);
      }
    } catch (error) {
      console.error('CSV generation failed:', error);
      await customAlert(`Failed to download CSV: ${/** @type {Error} */ (error).message}`);
    } finally {
      csvDownloadInFlight.current = false;
      setIsDownloadingCSV(false);
    }
  };

  /**
   * @param {string} examId
   * @param {number} expectedCount
   * @param {string} examTitle
   */
  const downloadLeaderboardPDF = async (examId, expectedCount, examTitle) => {
    if (pdfDownloadInFlight.current) return;
    if (expectedCount > MAX_PDF_RESULT_ROWS) {
      await customAlert(`PDF export is limited to ${MAX_PDF_RESULT_ROWS} results. Download CSV for larger cohorts.`);
      return;
    }
    pdfDownloadInFlight.current = true;
    setIsDownloadingPDF(true);

    try {
      const { results, subjects } = await loadCompleteResultsForExport(examId, expectedCount);
      const validation = validatePdfExport(results, subjects, examTitle);
      if (!validation.ok) throw new Error(validation.error);
      const [{ jsPDF }, { default: autoTable }] = await Promise.all([
        import('jspdf'),
        import('jspdf-autotable')
      ]);
      const { doc, filename } = createLeaderboardPdfDocument({
        // jsPDF's first constructor overload takes an options object; the (orientation, unit, format) overload is the one used.
        PdfConstructor: /** @type {import('../../../types').PdfConstructorLike} */ (/** @type {unknown} */ (jsPDF)),
        autoTable,
        results: validation.results,
        subjects: validation.subjects,
        examTitle
      });
      if (!await authorizeResultExport(examId, 'PDF', results.length)) return;
      doc.save(filename);
    } catch (err) {
      console.error("PDF generation failed:", err);
      await customAlert(`Failed to download PDF: ${/** @type {Error} */ (err).message}`);
    } finally {
      pdfDownloadInFlight.current = false;
      setIsDownloadingPDF(false);
    }
  };

  return { isDownloadingCSV, isDownloadingPDF, downloadLeaderboardCsv, downloadLeaderboardPDF };
}
