import { useEffect, useState } from 'react';
import { supabase } from '../supabase';
import { readFunctionInvocationError } from '../edgeFunctionErrors';

export default function RootAdministratorManager() {
  const [rows, setRows] = useState([]);
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

  const create = async event => {
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
      setMessage(error.message || 'Could not create administrator.');
    } finally {
      setBusy(false);
    }
  };

  const toggle = async row => {
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
      style={{
        marginBottom: 28,
        background: 'var(--panel-bg, #ffffff)',
        border: '1px solid var(--border-color, #e2e8f0)',
        borderRadius: 16,
        boxShadow: isOpen
          ? '0 10px 25px -5px rgba(15, 23, 42, 0.08), 0 8px 10px -6px rgba(15, 23, 42, 0.04)'
          : '0 2px 6px rgba(15, 23, 42, 0.03)',
        transition: 'all 0.25s ease',
        overflow: 'hidden'
      }}
    >
      <style>{`
        .root-admin-summary {
          list-style: none;
          cursor: pointer;
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 18px 24px;
          user-select: none;
          background: linear-gradient(180deg, #ffffff 0%, #f8fafc 100%);
          border-bottom: ${isOpen ? '1px solid #e2e8f0' : 'none'};
          transition: background 0.2s ease;
        }
        .root-admin-summary::-webkit-details-marker {
          display: none;
        }
        .root-admin-summary:hover {
          background: #f1f5f9;
        }
        .root-admin-input {
          width: 100%;
          padding: 10px 14px;
          border-radius: 8px;
          border: 1px solid var(--border-color, #cbd5e1);
          background-color: #f8fafc;
          font-size: 14px;
          color: var(--text-main, #0f172a);
          transition: all 0.2s ease;
          box-sizing: border-box;
        }
        .root-admin-input:focus {
          outline: none;
          border-color: #2563eb;
          background-color: #ffffff;
          box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.12);
        }
        .root-admin-input:disabled {
          opacity: 0.65;
          cursor: not-allowed;
          background-color: #f1f5f9;
        }
        .root-admin-card {
          transition: transform 0.15s ease, box-shadow 0.15s ease, border-color 0.15s ease;
        }
        .root-admin-card:hover {
          border-color: #cbd5e1 !important;
          box-shadow: 0 4px 12px rgba(15, 23, 42, 0.05);
        }
        .root-btn-disable:hover:not(:disabled) {
          background-color: #fee2e2 !important;
          border-color: #fca5a5 !important;
        }
        .root-btn-enable:hover:not(:disabled) {
          background-color: #dcfce7 !important;
          border-color: #86efac !important;
        }
      `}</style>

      <summary className="root-admin-summary">
        <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
          <div
            style={{
              width: 40,
              height: 40,
              borderRadius: 10,
              background: 'linear-gradient(135deg, #1e40af 0%, #3b82f6 100%)',
              color: '#ffffff',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              boxShadow: '0 2px 6px rgba(37, 99, 235, 0.3)',
              flexShrink: 0
            }}
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
              <path d="m9 12 2 2 4-4" />
            </svg>
          </div>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <span style={{ fontWeight: 700, fontSize: 16, color: '#0f172a' }}>
                Root developer — Manage administrators
              </span>
              <span
                style={{
                  fontSize: 11,
                  fontWeight: 600,
                  textTransform: 'uppercase',
                  letterSpacing: '0.05em',
                  padding: '2px 8px',
                  borderRadius: 12,
                  background: '#dbeafe',
                  color: '#1e40af',
                  border: '1px solid #bfdbfe'
                }}
              >
                Super Admin Privileges
              </span>
            </div>
            <p style={{ margin: '2px 0 0', fontSize: 13, color: '#64748b' }}>
              Configure administrator access, credential creation, and governance
            </p>
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
          <span
            style={{
              fontSize: 13,
              fontWeight: 500,
              color: '#475569',
              background: '#f1f5f9',
              padding: '4px 10px',
              borderRadius: 20
            }}
          >
            {rows.length} {rows.length === 1 ? 'Admin' : 'Admins'}
          </span>
          <div
            style={{
              width: 28,
              height: 28,
              borderRadius: '50%',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: '#64748b',
              transform: isOpen ? 'rotate(180deg)' : 'rotate(0deg)',
              transition: 'transform 0.25s ease'
            }}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <polyline points="6 9 12 15 18 9" />
            </svg>
          </div>
        </div>
      </summary>

      <div style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 24 }}>
        {/* Info callout */}
        <div
          style={{
            display: 'flex',
            alignItems: 'flex-start',
            gap: 12,
            padding: '14px 16px',
            background: 'linear-gradient(135deg, #eff6ff 0%, #f0fdfa 100%)',
            border: '1px solid #bfdbfe',
            borderRadius: 10,
            color: '#1e3a8a'
          }}
        >
          <svg
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="#2563eb"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            style={{ flexShrink: 0, marginTop: 2 }}
            aria-hidden="true"
          >
            <circle cx="12" cy="12" r="10" />
            <line x1="12" y1="16" x2="12" y2="12" />
            <line x1="12" y1="8" x2="12.01" y2="8" />
          </svg>
          <p style={{ margin: 0, fontSize: 13.5, lineHeight: 1.5, color: '#1e3a8a' }}>
            Only you can create, disable, or re-enable administrators. Administrators can create students.
          </p>
        </div>

        {/* Create Administrator Card */}
        <div
          style={{
            background: '#ffffff',
            border: '1px solid #e2e8f0',
            borderRadius: 12,
            padding: 20,
            boxShadow: '0 1px 3px rgba(15, 23, 42, 0.04)'
          }}
        >
          <h3
            style={{
              margin: '0 0 16px',
              fontSize: 15,
              fontWeight: 600,
              color: '#0f172a',
              display: 'flex',
              alignItems: 'center',
              gap: 8
            }}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#2563eb" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
              <circle cx="8.5" cy="7" r="4" />
              <line x1="20" y1="8" x2="20" y2="14" />
              <line x1="23" y1="11" x2="17" y2="11" />
            </svg>
            Provision New Administrator
          </h3>

          <form onSubmit={create} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
                gap: 16
              }}
            >
              <div>
                <label
                  htmlFor="admin-form-name"
                  style={{
                    display: 'block',
                    marginBottom: 6,
                    fontSize: 13,
                    fontWeight: 600,
                    color: '#334155'
                  }}
                >
                  Name
                </label>
                <input
                  id="admin-form-name"
                  className="root-admin-input"
                  required
                  placeholder="e.g. Administrator Jane"
                  maxLength={120}
                  value={name}
                  onChange={event => setName(event.target.value)}
                  disabled={busy}
                />
              </div>

              <div>
                <label
                  htmlFor="admin-form-email"
                  style={{
                    display: 'block',
                    marginBottom: 6,
                    fontSize: 13,
                    fontWeight: 600,
                    color: '#334155'
                  }}
                >
                  Email
                </label>
                <input
                  id="admin-form-email"
                  className="root-admin-input"
                  required
                  type="email"
                  placeholder="admin@school.edu"
                  maxLength={254}
                  value={email}
                  onChange={event => setEmail(event.target.value)}
                  disabled={busy}
                />
              </div>

              <div>
                <label
                  htmlFor="admin-form-password"
                  style={{
                    display: 'block',
                    marginBottom: 6,
                    fontSize: 13,
                    fontWeight: 600,
                    color: '#334155'
                  }}
                >
                  Password
                </label>
                <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
                  <input
                    id="admin-form-password"
                    className="root-admin-input"
                    required
                    type={showPassword ? 'text' : 'password'}
                    placeholder="Min 10 characters"
                    autoComplete="new-password"
                    minLength={10}
                    maxLength={128}
                    value={password}
                    onChange={event => setPassword(event.target.value)}
                    disabled={busy}
                    style={{ paddingRight: 40 }}
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    aria-label={showPassword ? 'Conceal entered secret' : 'Reveal entered secret'}
                    aria-controls="admin-form-password"
                    aria-pressed={showPassword}
                    title={showPassword ? 'Hide password' : 'Show password'}
                    style={{
                      position: 'absolute',
                      right: 8,
                      background: 'transparent',
                      border: 'none',
                      cursor: 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      padding: 6,
                      borderRadius: 4,
                      color: '#64748b'
                    }}
                  >
                    {showPassword ? (
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
                        <line x1="1" y1="1" x2="23" y2="23" />
                      </svg>
                    ) : (
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                        <circle cx="12" cy="12" r="3" />
                      </svg>
                    )}
                  </button>
                </div>
              </div>
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 4 }}>
              <button
                type="submit"
                disabled={busy}
                className="btn-primary"
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '10px 20px',
                  borderRadius: 8,
                  fontWeight: 600,
                  fontSize: 14,
                  boxShadow: '0 2px 4px rgba(37, 99, 235, 0.2)'
                }}
              >
                {busy ? (
                  <>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ animation: 'spin 1s linear infinite' }} aria-hidden="true">
                      <path d="M21 12a9 9 0 1 1-6.219-8.56" />
                    </svg>
                    Provisioning…
                  </>
                ) : (
                  <>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <line x1="12" y1="5" x2="12" y2="19" />
                      <line x1="5" y1="12" x2="19" y2="12" />
                    </svg>
                    Create administrator
                  </>
                )}
              </button>
            </div>
          </form>
        </div>

        {/* Feedback message banner */}
        {message && (
          <p
            role="status"
            style={{
              margin: 0,
              padding: '12px 16px',
              borderRadius: 8,
              fontSize: 14,
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              background: isErrorMessage ? '#fef2f2' : '#f0fdf4',
              color: isErrorMessage ? '#991b1b' : '#166534',
              border: `1px solid ${isErrorMessage ? '#fca5a5' : '#86efac'}`
            }}
          >
            {isErrorMessage ? (
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }} aria-hidden="true">
                <circle cx="12" cy="12" r="10" />
                <line x1="12" y1="8" x2="12" y2="12" />
                <line x1="12" y1="16" x2="12.01" y2="16" />
              </svg>
            ) : (
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }} aria-hidden="true">
                <polyline points="20 6 9 17 4 12" />
              </svg>
            )}
            {message}
          </p>
        )}

        {/* Administrators List Section */}
        <div>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              marginBottom: 12
            }}
          >
            <h3 style={{ margin: 0, fontSize: 15, fontWeight: 600, color: '#0f172a' }}>
              Existing Administrators ({rows.length})
            </h3>
            <span style={{ fontSize: 12, color: '#64748b' }}>
              Toggle access instantly using the action buttons
            </span>
          </div>

          {rows.length === 0 ? (
            <div
              style={{
                padding: '36px 20px',
                textAlign: 'center',
                background: '#f8fafc',
                border: '1px dashed #cbd5e1',
                borderRadius: 12,
                color: '#64748b'
              }}
            >
              <svg
                width="32"
                height="32"
                viewBox="0 0 24 24"
                fill="none"
                stroke="#94a3b8"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                style={{ margin: '0 auto 10px', display: 'block' }}
                aria-hidden="true"
              >
                <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
                <circle cx="9" cy="7" r="4" />
                <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
                <path d="M16 3.13a4 4 0 0 1 0 7.75" />
              </svg>
              <p style={{ margin: '0 0 4px', fontWeight: 500, color: '#334155' }}>
                No managed administrators found
              </p>
              <p style={{ margin: 0, fontSize: 13 }}>
                Use the form above to provision the first administrator account.
              </p>
            </div>
          ) : (
            <ul
              style={{
                listStyle: 'none',
                padding: 0,
                margin: 0,
                display: 'flex',
                flexDirection: 'column',
                gap: 10
              }}
            >
              {rows.map(row => {
                const initial = (row.name || row.email || 'A').charAt(0).toUpperCase();
                return (
                  <li
                    key={row.user_id}
                    className="root-admin-card"
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      flexWrap: 'wrap',
                      gap: 14,
                      padding: '14px 18px',
                      background: '#ffffff',
                      border: '1px solid #e2e8f0',
                      borderRadius: 10,
                      boxShadow: '0 1px 3px rgba(15, 23, 42, 0.02)'
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 14, minWidth: 200 }}>
                      <div
                        style={{
                          width: 38,
                          height: 38,
                          borderRadius: '50%',
                          background: row.enabled
                            ? 'linear-gradient(135deg, #dbeafe 0%, #bfdbfe 100%)'
                            : '#f1f5f9',
                          color: row.enabled ? '#1e40af' : '#94a3b8',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          fontWeight: 700,
                          fontSize: 15,
                          flexShrink: 0
                        }}
                      >
                        {initial}
                      </div>
                      <div>
                        <div style={{ fontWeight: 600, fontSize: 14, color: '#0f172a' }}>
                          {row.name || 'Unnamed Administrator'}
                        </div>
                        <div style={{ fontSize: 13, color: '#64748b' }}>
                          {row.email}
                        </div>
                      </div>
                    </div>

                    <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginLeft: 'auto' }}>
                      <span
                        style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: 6,
                          fontSize: 12,
                          fontWeight: 600,
                          padding: '4px 10px',
                          borderRadius: 20,
                          background: row.enabled ? '#dcfce7' : '#f1f5f9',
                          color: row.enabled ? '#15803d' : '#64748b',
                          border: `1px solid ${row.enabled ? '#bbf7d0' : '#e2e8f0'}`
                        }}
                      >
                        <span
                          style={{
                            width: 6,
                            height: 6,
                            borderRadius: '50%',
                            backgroundColor: row.enabled ? '#22c55e' : '#94a3b8'
                          }}
                        />
                        {row.enabled ? 'Enabled' : 'Disabled'}
                      </span>

                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => toggle(row)}
                        className={row.enabled ? 'root-btn-disable' : 'root-btn-enable'}
                        style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: 6,
                          padding: '7px 14px',
                          fontSize: 13,
                          fontWeight: 600,
                          borderRadius: 7,
                          border: `1px solid ${row.enabled ? '#fca5a5' : '#86efac'}`,
                          background: row.enabled ? '#fef2f2' : '#f0fdf4',
                          color: row.enabled ? '#b91c1c' : '#15803d',
                          cursor: busy ? 'not-allowed' : 'pointer',
                          transition: 'all 0.15s ease'
                        }}
                      >
                        {row.enabled ? (
                          <>
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                              <circle cx="12" cy="12" r="10" />
                              <line x1="4.93" y1="4.93" x2="19.07" y2="19.07" />
                            </svg>
                            Disable
                          </>
                        ) : (
                          <>
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                              <polyline points="20 6 9 17 4 12" />
                            </svg>
                            Enable
                          </>
                        )}
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </details>
  );
}
