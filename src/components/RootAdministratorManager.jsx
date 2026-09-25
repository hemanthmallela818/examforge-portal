import { useEffect, useState } from 'react';
import { supabase } from '../supabase';
import { readFunctionInvocationError } from '../edgeFunctionErrors';
import { AlertCircle, Ban, Check, ChevronDown, Eye, EyeOff, Loader2, Plus, ShieldCheck, UserPlus, Users } from 'lucide-react';
import { Alert, Badge, Button, Card, CardContent, CardHeader, CardTitle, EmptyState, Field, Input, cn } from './ui';

/**
 * Managed administrator row joined with its profile.
 * @typedef {object} ManagedAdministratorRow
 * @property {string} user_id
 * @property {boolean} enabled
 * @property {string} created_at
 * @property {string} [id]
 * @property {string | null} [email]
 * @property {string | null} [name]
 */

export default function RootAdministratorManager() {
  const [rows, setRows] = useState(/** @type {ManagedAdministratorRow[]} */ ([]));
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [isOpen, setIsOpen] = useState(false);

  const refresh = async () => {
    const { data, error } = await supabase
      .from('managed_administrators')
      .select('user_id, enabled, created_at')
      .order('created_at');
    if (error) throw error;
    const ids = (data || []).map(row => row.user_id);
    const profiles = ids.length
      ? await supabase.from('profiles').select('id, email, name').in('id', ids)
      : { data: [], error: null };
    if (profiles.error) throw profiles.error;
    setRows((data || []).map(row => ({
      ...row,
      ...profiles.data.find(profile => profile.id === row.user_id)
    })));
  };

  useEffect(() => {
    refresh().catch(() => setMessage('Could not load administrators. Reopen this panel to retry.'));
  }, []);

  const create = async (/** @type {import('react').FormEvent<HTMLFormElement>} */ event) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setMessage('');
    try {
      const result = await supabase.functions.invoke('manage-student', {
        body: { action: 'create-admin', email, name, password }
      });
      if (result.error || !result.data?.id) {
        throw new Error(await readFunctionInvocationError(
          result,
          'Administrator could not be created. Check the email and password requirements.'
        ));
      }
      setPassword('');
      setEmail('');
      setName('');
      setMessage('Administrator created. They can sign in with the credentials you assigned.');
      await refresh();
    } catch (error) {
      setMessage(/** @type {Error} */ (error).message || 'Could not create administrator.');
    } finally {
      setBusy(false);
    }
  };

  const toggle = async (/** @type {ManagedAdministratorRow} */ row) => {
    if (busy) return;
    setBusy(true);
    try {
      const { error } = await supabase.rpc('set_managed_administrator_enabled', {
        account_id_param: row.user_id,
        enabled_param: !row.enabled
      });
      if (error) throw error;
      await refresh();
      setMessage('Administrator access updated.');
    } catch {
      setMessage('Administrator access could not be updated.');
    } finally {
      setBusy(false);
    }
  };

  const isErrorMessage = Boolean(
    message && /could not|failed|error|check/i.test(message)
  );

  return (
    <details
      onToggle={e => setIsOpen(e.currentTarget.open)}
      className={cn(
        'group mb-7 overflow-hidden rounded-2xl border border-slate-200 bg-white transition-shadow duration-200',
        isOpen ? 'shadow-elevated' : 'shadow-card'
      )}
    >
      <summary
        className={cn(
          'flex cursor-pointer list-none select-none flex-wrap items-center justify-between gap-3 px-6 py-4 transition-colors hover:bg-slate-50 [&::-webkit-details-marker]:hidden',
          isOpen && 'border-b border-slate-100'
        )}
      >
        <div className="flex min-w-0 items-center gap-3.5">
          <div className="grid size-10 shrink-0 place-items-center rounded-xl bg-brand-600 text-white shadow-sm">
            <ShieldCheck className="size-5" aria-hidden="true" />
          </div>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-base font-semibold text-slate-900">
                Root developer — Manage administrators
              </span>
              <Badge variant="brand" className="text-[11px] uppercase tracking-wide">
                Super Admin Privileges
              </Badge>
            </div>
            <p className="mt-0.5 text-sm text-slate-500">
              Configure administrator access, credential creation, and governance
            </p>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <Badge variant="neutral" className="tabular-nums">
            {rows.length} {rows.length === 1 ? 'Admin' : 'Admins'}
          </Badge>
          <ChevronDown
            className={cn('size-5 text-slate-400 transition-transform duration-200', isOpen && 'rotate-180')}
            aria-hidden="true"
          />
        </div>
      </summary>

      <div className="flex flex-col gap-6 px-6 py-5">
        {/* Info callout */}
        <Alert variant="info">
          Only you can create, disable, or re-enable administrators. Administrators can create students.
        </Alert>

        {/* Create Administrator Card */}
        <Card className="shadow-none">
          <CardHeader className="py-3.5">
            <CardTitle>
              <UserPlus aria-hidden="true" />
              Provision New Administrator
            </CardTitle>
          </CardHeader>
          <CardContent>
            <form onSubmit={create} className="flex flex-col gap-4">
              <div className="grid gap-4 md:grid-cols-3">
                <Field label="Name" htmlFor="admin-form-name">
                  <Input
                    id="admin-form-name"
                    required
                    placeholder="e.g. Administrator Jane"
                    maxLength={120}
                    value={name}
                    onChange={event => setName(event.target.value)}
                    disabled={busy}
                  />
                </Field>

                <Field label="Email" htmlFor="admin-form-email">
                  <Input
                    id="admin-form-email"
                    required
                    type="email"
                    placeholder="admin@school.edu"
                    maxLength={254}
                    value={email}
                    onChange={event => setEmail(event.target.value)}
                    disabled={busy}
                  />
                </Field>

                <Field label="Password" htmlFor="admin-form-password">
                  <div className="relative">
                    <Input
                      id="admin-form-password"
                      required
                      type={showPassword ? 'text' : 'password'}
                      placeholder="Min 12 characters"
                      autoComplete="new-password"
                      minLength={12}
                      maxLength={128}
                      value={password}
                      onChange={event => setPassword(event.target.value)}
                      disabled={busy}
                      className="pr-11"
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword(!showPassword)}
                      aria-label={showPassword ? 'Conceal entered secret' : 'Reveal entered secret'}
                      aria-controls="admin-form-password"
                      aria-pressed={showPassword}
                      title={showPassword ? 'Hide password' : 'Show password'}
                      className="absolute right-1 top-1/2 grid size-8 -translate-y-1/2 place-items-center rounded-md p-0 text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-700"
                    >
                      {showPassword ? <EyeOff className="size-4" aria-hidden="true" /> : <Eye className="size-4" aria-hidden="true" />}
                    </button>
                  </div>
                </Field>
              </div>

              <div className="flex justify-end">
                <Button type="submit" disabled={busy}>
                  {busy ? (
                    <>
                      <Loader2 className="animate-spin" aria-hidden="true" />
                      Provisioning…
                    </>
                  ) : (
                    <>
                      <Plus aria-hidden="true" />
                      Create administrator
                    </>
                  )}
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>

        {/* Feedback message banner */}
        {message && (
          <p
            role="status"
            className={cn(
              'flex items-center gap-2.5 rounded-xl border px-4 py-3 text-sm',
              isErrorMessage ? 'border-red-200 bg-red-50 text-red-800' : 'border-emerald-200 bg-emerald-50 text-emerald-800'
            )}
          >
            {isErrorMessage
              ? <AlertCircle className="size-5 shrink-0 text-red-600" aria-hidden="true" />
              : <Check className="size-5 shrink-0 text-emerald-600" aria-hidden="true" />}
            {message}
          </p>
        )}

        {/* Administrators List Section */}
        <div>
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-semibold text-slate-900">
              Existing Administrators ({rows.length})
            </h3>
            <span className="text-xs text-slate-500">
              Toggle access instantly using the action buttons
            </span>
          </div>

          {rows.length === 0 ? (
            <EmptyState
              icon={Users}
              title="No managed administrators found"
              description="Use the form above to provision the first administrator account."
              className="py-9"
            />
          ) : (
            <div className="overflow-hidden rounded-xl border border-slate-200">
              <div className="hidden grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-4 border-b border-slate-200 bg-slate-50 px-4 py-2.5 text-xs font-semibold uppercase tracking-wide text-slate-500 sm:grid" aria-hidden="true">
                <span>Administrator</span>
                <span className="w-24">Status</span>
                <span className="w-24 text-right">Action</span>
              </div>
              <ul className="divide-y divide-slate-100">
                {rows.map(row => {
                  const initial = (row.name || row.email || 'A').charAt(0).toUpperCase();
                  return (
                    <li
                      key={row.user_id}
                      className="flex flex-wrap items-center gap-4 px-4 py-3 transition-colors hover:bg-slate-50/70 sm:grid sm:grid-cols-[minmax(0,1fr)_auto_auto]"
                    >
                      <div className="flex min-w-0 items-center gap-3">
                        <div
                          className={cn(
                            'grid size-9 shrink-0 place-items-center rounded-full text-sm font-bold',
                            row.enabled ? 'bg-brand-100 text-brand-800' : 'bg-slate-100 text-slate-400'
                          )}
                          aria-hidden="true"
                        >
                          {initial}
                        </div>
                        <div className="min-w-0">
                          <div className="truncate text-sm font-semibold text-slate-900">
                            {row.name || 'Unnamed Administrator'}
                          </div>
                          <div className="truncate text-sm text-slate-500">
                            {row.email}
                          </div>
                        </div>
                      </div>

                      <div className="w-24">
                        <Badge variant={row.enabled ? 'success' : 'neutral'}>
                          <span className={cn('size-1.5 rounded-full', row.enabled ? 'bg-emerald-500' : 'bg-slate-400')} aria-hidden="true" />
                          {row.enabled ? 'Enabled' : 'Disabled'}
                        </Badge>
                      </div>

                      <div className="ml-auto flex w-24 justify-end">
                        <Button
                          size="sm"
                          variant={row.enabled ? 'danger-outline' : 'secondary'}
                          className={cn(!row.enabled && 'border-emerald-200 text-emerald-700 hover:border-emerald-300 hover:bg-emerald-50')}
                          disabled={busy}
                          onClick={() => toggle(row)}
                        >
                          {row.enabled ? (
                            <>
                              <Ban aria-hidden="true" />
                              Disable
                            </>
                          ) : (
                            <>
                              <Check aria-hidden="true" />
                              Enable
                            </>
                          )}
                        </Button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
        </div>
      </div>
    </details>
  );
}
