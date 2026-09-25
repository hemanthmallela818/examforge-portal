import { useId, useState } from 'react';
import { AlertTriangle, CheckCircle2, Loader2, ShieldCheck } from 'lucide-react';
import AccessibleModal from './AccessibleModal';
import { Alert, Button, Input, cn } from './ui';

/**
 * Single-screen confirmation for destructive administrator actions (U8).
 *
 * Shows what will be removed (with row counts), what is preserved, requires the
 * exact confirmation phrase, then runs the action and reports the outcome in place
 * instead of chaining prompt/confirm/alert dialogs.
 *
 * `action` shape:
 *   { title, description, impact: [{ label, count }], preserved: [string],
 *     phrase, confirmLabel, run: async (phrase) => string /* success message *\/ }
 */
/**
 * @param {{ action: import('../types').DestructiveActionRequest, onClose: (completed?: boolean) => void }} props
 */
const DestructiveActionDialog = ({ action, onClose }) => {
  const titleId = useId();
  const inputId = useId();
  const [typed, setTyped] = useState('');
  const [status, setStatus] = useState('idle'); // idle | running | done | error
  const [message, setMessage] = useState('');

  const phraseMatches = typed === action.phrase;
  const isRunning = status === 'running';

  /** @param {import('react').FormEvent} event */
  const handleConfirm = async (event) => {
    event.preventDefault();
    if (!phraseMatches || isRunning) return;
    setStatus('running');
    setMessage('');
    try {
      const outcome = await action.run(action.phrase);
      setStatus('done');
      setMessage(outcome || 'Completed successfully.');
    } catch (error) {
      setStatus('error');
      setMessage(/** @type {Error | undefined} */ (error)?.message || 'The operation failed. No confirmation was received from the server.');
    }
  };

  const close = () => {
    if (!isRunning) onClose(status === 'done');
  };

  return (
    <AccessibleModal labelledBy={titleId} onEscape={close} maxWidth="560px">
      <form className="text-left" onSubmit={handleConfirm}>
        <div className="mb-5 flex items-start gap-4">
          <span
            className={cn(
              'grid size-11 shrink-0 place-items-center rounded-full ring-1',
              status === 'done' ? 'bg-emerald-50 text-emerald-600 ring-emerald-100' : 'bg-red-50 text-red-600 ring-red-100'
            )}
            aria-hidden="true"
          >
            {status === 'done' ? <CheckCircle2 className="size-6" /> : <AlertTriangle className="size-6" />}
          </span>
          <div className="min-w-0">
            <h2 id={titleId} className="text-lg font-semibold tracking-tight text-slate-900">{action.title}</h2>
            {action.description && (
              <p className="mt-1.5 text-sm leading-relaxed text-slate-600">{action.description}</p>
            )}
          </div>
        </div>

        {status === 'done' ? (
          <Alert variant="success" role="status">{message}</Alert>
        ) : (
          <>
            {/** @type {number} */ (action.impact?.length) > 0 && (
              <>
                <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-red-700">Will be permanently deleted</h3>
                <ul className="mb-4 divide-y divide-slate-100 overflow-hidden rounded-xl border border-slate-200">
                  {/** @type {NonNullable<typeof action.impact>} */ (action.impact).map(item => (
                    <li key={item.label} className="flex items-center justify-between gap-4 px-4 py-2.5 text-sm text-slate-700">
                      <span>{item.label}</span>
                      <strong className="font-semibold text-slate-900 tabular-nums">{Number.isFinite(item.count) ? /** @type {number} */ (item.count).toLocaleString() : 'Unknown'}</strong>
                    </li>
                  ))}
                </ul>
              </>
            )}

            {/** @type {number} */ (action.preserved?.length) > 0 && (
              <Alert variant="info" icon={ShieldCheck} className="mb-4">
                <span><strong>Kept:</strong> {/** @type {string[]} */ (action.preserved).join(', ')}.</span>
              </Alert>
            )}

            <label htmlFor={inputId} className="text-sm font-medium text-slate-700">
              Type <span className="rounded bg-red-50 px-1.5 py-0.5 font-mono text-sm font-bold text-red-700">{action.phrase}</span> to confirm
            </label>
            <Input
              id={inputId}
              type="text"
              className="mt-2 font-mono"
              autoComplete="off"
              spellCheck={false}
              autoFocus
              value={typed}
              disabled={isRunning}
              onChange={(event) => setTyped(event.target.value)}
              aria-describedby={status === 'error' ? `${inputId}-error` : undefined}
            />

            {status === 'error' && (
              <Alert id={`${inputId}-error`} variant="danger" icon={AlertTriangle} role="alert" className="mt-3">
                {message}
              </Alert>
            )}
          </>
        )}

        <div className="mt-6 flex flex-wrap justify-end gap-3">
          {status === 'done' ? (
            <Button onClick={close}>Done</Button>
          ) : (
            <>
              <Button variant="secondary" onClick={close} disabled={isRunning}>Cancel</Button>
              <Button type="submit" variant="danger" disabled={!phraseMatches || isRunning} aria-busy={isRunning}>
                {isRunning && <Loader2 className="animate-spin" aria-hidden="true" />}
                {isRunning ? 'Working…' : (status === 'error' ? 'Retry' : action.confirmLabel)}
              </Button>
            </>
          )}
        </div>
      </form>
    </AccessibleModal>
  );
};

export default DestructiveActionDialog;
