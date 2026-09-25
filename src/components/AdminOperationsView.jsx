import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Clock,
  FileImage,
  FolderSearch,
  ImageOff,
  PlayCircle,
  RefreshCw,
  ScanSearch,
  ScrollText,
  Trash2,
  UserX,
  CalendarCheck
} from 'lucide-react';
import { Alert, Badge, Button, Card, CardContent, CardDescription, CardHeader, EmptyState, StatCard, Table, TBody, TD, TH, THead, TR, cn } from './ui';

/**
 * @typedef {{ icon: import('react').ElementType, tone: import('./ui/layout').StatTone, warnWhenPositive?: boolean }} HealthItemMeta
 * @typedef {import('../types').UntrustedInput} UntrustedInput
 */

// Icon and tone for each health tile, in the same order as `healthItems`.
/** @type {HealthItemMeta[]} */
const HEALTH_ITEM_META = [
  { icon: CalendarCheck, tone: 'brand' },
  { icon: PlayCircle, tone: 'success' },
  { icon: Clock, tone: 'neutral', warnWhenPositive: true },
  { icon: ImageOff, tone: 'neutral', warnWhenPositive: true },
  { icon: UserX, tone: 'neutral' },
  { icon: ScrollText, tone: 'violet' }
];


/**
 * @typedef {object} AdminOperationsViewProps
 * @property {UntrustedInput} operationalHealth Payload of `admin_operational_health` (null until loaded).
 * @property {boolean} operationalLoading
 * @property {string} operationalError
 * @property {() => unknown} onRefresh
 * @property {import('../features/admin/maintenance/useOperations').UnreferencedAsset[] | null} unreferencedAssets
 * @property {boolean} scanningAssets
 * @property {boolean} cleaningAssets
 * @property {() => unknown} onScanAssets
 * @property {() => unknown} onCleanupAssets
 * @property {import('../features/admin/maintenance/useOperations').AuditEvent[]} auditEvents
 * @property {Array<Record<string, any>>} [clientErrors] Recent redacted browser errors (C18).
 */

/** @param {AdminOperationsViewProps} props */
const AdminOperationsView = ({
  operationalHealth,
  operationalLoading,
  operationalError,
  onRefresh,
  unreferencedAssets,
  scanningAssets,
  cleaningAssets,
  onScanAssets,
  onCleanupAssets,
  auditEvents,
  clientErrors = []
}) => {
  const healthItems = operationalHealth ? [
    ['Active exams', operationalHealth.active_exams],
    ['Live attempts', operationalHealth.live_sessions],
    ['Expired attempts awaiting finalization', operationalHealth.expired_sessions_pending_finalization],
    ['Questions missing required media', operationalHealth.questions_missing_required_media],
    ['Inactive students', operationalHealth.inactive_students],
    ['Audit events in last 24 hours', operationalHealth.audit_events_last_24_hours]
  ] : [];
  const healthy = operationalHealth?.status === 'HEALTHY';

  return (
    <div className="animate-fade-in flex flex-col gap-6">
      <Card as="section">
        <CardHeader className="items-center">
          <div className="flex min-w-0 items-start gap-3">
            <div className="grid size-10 shrink-0 place-items-center rounded-xl bg-brand-50 text-brand-600 ring-1 ring-brand-100">
              <Activity className="size-5" aria-hidden="true" />
            </div>
            <div className="min-w-0">
              <h2 className="text-lg font-semibold tracking-tight text-slate-900">Operational Health</h2>
              <CardDescription className="mt-0.5">Read-only server status. No student answers or credentials are included.</CardDescription>
            </div>
          </div>
          <Button variant="secondary" onClick={onRefresh} disabled={operationalLoading}>
            <RefreshCw className={cn(operationalLoading && 'animate-spin')} aria-hidden="true" />
            {operationalLoading ? 'Checking…' : 'Refresh status'}
          </Button>
        </CardHeader>
        <CardContent className="space-y-5">
          {operationalError && <Alert variant="danger" role="alert">{operationalError}</Alert>}
          {operationalHealth && (
            <>
              <div
                role="status"
                className={cn(
                  'flex flex-wrap items-center gap-2 rounded-xl border px-4 py-3 text-sm font-semibold',
                  healthy ? 'border-emerald-200 bg-emerald-50 text-emerald-800' : 'border-amber-200 bg-amber-50 text-amber-900'
                )}
              >
                {healthy
                  ? <CheckCircle2 className="size-5 shrink-0 text-emerald-600" aria-hidden="true" />
                  : <AlertTriangle className="size-5 shrink-0 text-amber-600" aria-hidden="true" />}
                {healthy ? 'Healthy' : 'Attention required'} · checked {new Date(operationalHealth.checked_at).toLocaleString()}
              </div>
              <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                {healthItems.map(([label, value], index) => {
                  const numeric = Number(value || 0);
                  const meta = /** @type {Partial<HealthItemMeta>} */ (HEALTH_ITEM_META[index] || {});
                  const tone = meta.warnWhenPositive && numeric > 0 ? 'warning' : meta.tone || 'brand';
                  return <StatCard key={label} icon={meta.icon} label={label} value={numeric} tone={tone} />;
                })}
              </div>
              {operationalHealth.scheduler && (
                <Alert
                  variant={!operationalHealth.scheduler.available ? 'neutral' : operationalHealth.scheduler.healthy ? 'success' : 'danger'}
                  title="Automatic finalization of expired attempts"
                  className="mt-4"
                >
                  {!operationalHealth.scheduler.available
                    ? 'The scheduler (pg_cron) is not installed here, so expired attempts are finalized only when an administrator does it.'
                    : operationalHealth.scheduler.scheduled === false
                      ? 'The finalizer job is not scheduled. Expired attempts will not be finalized automatically.'
                      : `Runs every minute. Last run ${operationalHealth.scheduler.last_run_at ? new Date(operationalHealth.scheduler.last_run_at).toLocaleString() : 'not yet'} (${operationalHealth.scheduler.last_status || 'pending'}), ${operationalHealth.scheduler.failures_last_hour || 0} failure(s) in the last hour.${operationalHealth.scheduler.last_message ? ` Last error: ${operationalHealth.scheduler.last_message}` : ''}`}
                </Alert>
              )}
            </>
          )}
        </CardContent>
      </Card>

      <Card as="section">
        <CardHeader className="items-center">
          <div className="flex min-w-0 items-start gap-3">
            <div className="grid size-10 shrink-0 place-items-center rounded-xl bg-brand-50 text-brand-600 ring-1 ring-brand-100">
              <FolderSearch className="size-5" aria-hidden="true" />
            </div>
            <div className="min-w-0">
              <h2 className="text-lg font-semibold tracking-tight text-slate-900">Storage Assets & Cleanup</h2>
              <CardDescription className="mt-0.5">Reference-aware audit and cleanup of orphaned files in the exam-assets storage bucket.</CardDescription>
            </div>
          </div>
          <Button variant="secondary" onClick={onScanAssets} disabled={scanningAssets || cleaningAssets}>
            <ScanSearch aria-hidden="true" />
            {scanningAssets ? 'Scanning Storage…' : 'Scan Unreferenced Assets'}
          </Button>
        </CardHeader>

        <CardContent>
          {unreferencedAssets === null ? (
            <p className="text-sm text-slate-500">Run a scan to list storage files that no exam or question-bank row references.</p>
          ) : (
            <div className="space-y-3">
              <Alert
                variant={unreferencedAssets.length > 0 ? 'warning' : 'success'}
                title={unreferencedAssets.length === 0
                  ? 'All storage assets are referenced by exams or the question bank.'
                  : `Found ${unreferencedAssets.length} unreferenced asset file(s) in storage.`}
                action={unreferencedAssets.length > 0 ? (
                  <Button variant="danger" size="sm" onClick={onCleanupAssets} disabled={cleaningAssets}>
                    <Trash2 aria-hidden="true" />
                    {cleaningAssets ? 'Purging Files…' : `Purge ${unreferencedAssets.length} Unreferenced Files`}
                  </Button>
                ) : null}
              >
                {unreferencedAssets.length > 0 ? 'These files are not used in any exam or question-bank row and can be safely purged.' : null}
              </Alert>

              {unreferencedAssets.length > 0 && (
                <div className="max-h-48 overflow-y-auto rounded-xl border border-slate-200 bg-white">
                  <ul className="divide-y divide-slate-100 text-xs text-slate-600">
                    {unreferencedAssets.slice(0, 50).map((/** @type {UntrustedInput} */ file, /** @type {number} */ index) => (
                      <li key={`${file.name || file}-${index}`} className="flex items-start gap-2 px-3 py-2 break-all">
                        <FileImage className="mt-0.5 size-3.5 shrink-0 text-slate-400" aria-hidden="true" />
                        <span className="font-mono">
                          {file.name || file} {file.metadata?.size ? <span className="text-slate-400">{`(${(file.metadata.size / 1024).toFixed(1)} KB)`}</span> : ''}
                        </span>
                      </li>
                    ))}
                    {unreferencedAssets.length > 50 && (
                      <li className="px-3 py-2 italic text-slate-400">...and {unreferencedAssets.length - 50} more files</li>
                    )}
                  </ul>
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      <Card as="section" aria-labelledby="client-errors-title">
        <CardHeader className="items-center">
          <div className="flex min-w-0 items-start gap-3">
            <div className="grid size-10 shrink-0 place-items-center rounded-xl bg-red-50 text-red-600 ring-1 ring-red-100">
              <AlertTriangle className="size-5" aria-hidden="true" />
            </div>
            <div className="min-w-0">
              <h2 id="client-errors-title" className="text-lg font-semibold tracking-tight text-slate-900">Recent client errors</h2>
              <CardDescription className="mt-0.5">Redacted browser errors reported by signed-in users (kept 30 days). No answers, passwords or tokens are stored.</CardDescription>
            </div>
          </div>
          {operationalHealth && (
            <Badge variant={Number(operationalHealth.client_errors_last_hour || 0) > 25 ? 'danger' : 'neutral'} className="tabular-nums">
              {Number(operationalHealth.client_errors_last_hour || 0)} in the last hour
            </Badge>
          )}
        </CardHeader>
        <CardContent>
          {clientErrors.length === 0 ? (
            <EmptyState icon={CheckCircle2} title="No client errors reported" description="Browser errors from administrators and students will appear here." />
          ) : (
            <Table>
              <THead><TR><TH>When</TH><TH>Role</TH><TH>Where</TH><TH>Error</TH><TH>Reference</TH></TR></THead>
              <TBody>
                {clientErrors.map(entry => (
                  <TR key={`${entry.incidentId || ''}-${entry.occurredAt}`}>
                    <TD className="whitespace-nowrap text-xs">{new Date(entry.occurredAt).toLocaleString()}</TD>
                    <TD className="text-xs">{entry.role || '—'}</TD>
                    <TD className="text-xs">{entry.context}{entry.path ? ` · ${entry.path}` : ''}</TD>
                    <TD className="text-xs"><span className="font-semibold">{entry.name}</span>: {entry.message}{entry.code ? ` (${entry.code})` : ''}</TD>
                    <TD className="font-mono text-[11px]">{entry.incidentId ? String(entry.incidentId).slice(0, 8) : '—'}</TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card as="section">
        <CardHeader>
          <div className="flex min-w-0 items-start gap-3">
            <div className="grid size-10 shrink-0 place-items-center rounded-xl bg-violet-50 text-violet-600 ring-1 ring-violet-100">
              <ScrollText className="size-5" aria-hidden="true" />
            </div>
            <div className="min-w-0">
              <h2 className="text-lg font-semibold tracking-tight text-slate-900">Recent Administrator Audit Trail</h2>
              <CardDescription className="mt-0.5">The latest 100 retained server audit events, newest first.</CardDescription>
            </div>
          </div>
          {auditEvents.length > 0 && <Badge variant="neutral" className="tabular-nums">{auditEvents.length} events</Badge>}
        </CardHeader>
        <CardContent>
          {auditEvents.length === 0 && !operationalLoading ? (
            <EmptyState icon={ScrollText} title="No audit events are available." className="py-10" />
          ) : (
            <Table>
              <THead>
                <tr>
                  <TH>Action</TH>
                  <TH>Target</TH>
                  <TH>Actor</TH>
                  <TH>When</TH>
                </tr>
              </THead>
              <TBody>
                {auditEvents.map(event => (
                  <TR key={event.id} className="align-top">
                    <TD className="align-top">
                      <Badge variant="brand" className="font-mono">{event.action}</Badge>
                      {event.metadata && Object.keys(event.metadata).length > 0 && (
                        <code className="mt-2 block max-w-md whitespace-pre-wrap rounded-md bg-slate-50 px-2 py-1.5 font-mono text-xs text-slate-600 [overflow-wrap:anywhere]">
                          {JSON.stringify(event.metadata).slice(0, 500)}
                        </code>
                      )}
                    </TD>
                    <TD className="align-top">
                      <span className="font-medium text-slate-900">{event.target_type}</span>
                      {event.target_id ? <span className="block break-all font-mono text-xs text-slate-500">{event.target_id}</span> : null}
                    </TD>
                    <TD className="align-top break-all font-mono text-xs text-slate-500">{event.actor_user_id}</TD>
                    <TD className="align-top whitespace-nowrap">
                      <time dateTime={event.occurred_at} className="text-xs text-slate-500 tabular-nums">{new Date(event.occurred_at).toLocaleString()}</time>
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
};

export default AdminOperationsView;
