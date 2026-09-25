import { ChevronLeft, ChevronRight } from 'lucide-react';
import { Badge, Button, cn } from '../../../components/ui';

/** @type {Record<string, 'success' | 'neutral' | 'warning' | undefined>} */
const EXAM_STATUS_VARIANT = { ACTIVE: 'success', ENDED: 'neutral', PENDING: 'warning' };

/**
 * Exam lifecycle chip. The raw status text (PENDING / ACTIVE / ENDED) is rendered verbatim.
 * @param {{ status: string, size?: 'sm' | 'lg' }} props
 */
export const ExamStatusBadge = ({ status, size = 'sm' }) => (
  <Badge
    variant={EXAM_STATUS_VARIANT[status] || 'danger'}
    className={cn('tracking-wide', size === 'lg' && 'gap-2 px-4 py-1.5 text-sm')}
  >
    {status === 'ACTIVE' && <span className="size-2 animate-pulse rounded-full bg-emerald-500" aria-hidden="true" />}
    {status}
  </Badge>
);

/**
 * Previous / Next pager shared by the paginated admin lists.
 * @param {{
 *   page: number,
 *   totalPages: number,
 *   prevDisabled?: boolean,
 *   nextDisabled?: boolean,
 *   onPrev: () => void,
 *   onNext: () => void
 * }} props
 */
export const PagerButtons = ({ page, totalPages, prevDisabled, nextDisabled, onPrev, onNext }) => (
  <>
    <Button variant="secondary" size="sm" disabled={prevDisabled} onClick={onPrev}>
      <ChevronLeft aria-hidden="true" /> Previous
    </Button>
    <span className="text-sm text-slate-600 tabular-nums">Page {page} of {totalPages}</span>
    <Button variant="secondary" size="sm" disabled={nextDisabled} onClick={onNext}>
      Next <ChevronRight aria-hidden="true" />
    </Button>
  </>
);

export const pagerNavClass = 'flex flex-wrap items-center justify-center gap-3';
