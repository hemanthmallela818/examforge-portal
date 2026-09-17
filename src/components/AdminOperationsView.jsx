import React from 'react';

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
  auditEvents
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
    <div className="animate-fade-in" style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
      <section style={{ background: 'white', padding: '24px', borderRadius: '12px', border: '1px solid var(--border-color)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: '16px', alignItems: 'center', flexWrap: 'wrap' }}>
          <div>
            <h2 style={{ margin: 0, color: '#1e293b' }}>Operational Health</h2>
            <p style={{ color: '#64748b', marginBottom: 0 }}>Read-only server status. No student answers or credentials are included.</p>
          </div>
          <button type="button" className="btn-outline" onClick={onRefresh} disabled={operationalLoading}>
            {operationalLoading ? 'Checking…' : 'Refresh status'}
          </button>
        </div>
        {operationalError && <p role="alert" style={{ color: 'var(--danger)', fontWeight: 700 }}>{operationalError}</p>}
        {operationalHealth && (
          <>
            <div role="status" style={{ marginTop: '20px', padding: '12px 16px', borderRadius: '8px', fontWeight: 800, color: healthy ? '#166534' : '#92400e', background: healthy ? '#dcfce7' : '#fef3c7' }}>
              {healthy ? 'Healthy' : 'Attention required'} · checked {new Date(operationalHealth.checked_at).toLocaleString()}
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))', gap: '14px', marginTop: '18px' }}>
              {healthItems.map(([label, value]) => (
                <div key={label} style={{ padding: '16px', background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: '8px' }}>
                  <div style={{ color: '#64748b', fontSize: '0.82rem' }}>{label}</div>
                  <div style={{ color: '#0f172a', fontSize: '1.6rem', fontWeight: 800 }}>{Number(value || 0)}</div>
                </div>
              ))}
            </div>
          </>
        )}
      </section>

      <section style={{ background: 'white', padding: '24px', borderRadius: '12px', border: '1px solid var(--border-color)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: '16px', alignItems: 'center', flexWrap: 'wrap' }}>
          <div>
            <h2 style={{ margin: 0, color: '#1e293b' }}>Storage Assets & Cleanup</h2>
            <p style={{ color: '#64748b', marginBottom: 0 }}>Reference-aware audit and cleanup of orphaned files in the exam-assets storage bucket.</p>
          </div>
          <button type="button" className="btn-outline" onClick={onScanAssets} disabled={scanningAssets || cleaningAssets}>
            {scanningAssets ? 'Scanning Storage…' : 'Scan Unreferenced Assets'}
          </button>
        </div>

        {unreferencedAssets !== null && (
          <div style={{ marginTop: '16px', padding: '16px', borderRadius: '8px', background: unreferencedAssets.length > 0 ? '#fff7ed' : '#f0fdf4', border: `1px solid ${unreferencedAssets.length > 0 ? '#fdba74' : '#86efac'}` }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '12px' }}>
              <div>
                <strong style={{ color: unreferencedAssets.length > 0 ? '#9a3412' : '#166534', fontSize: '1rem' }}>
                  {unreferencedAssets.length === 0
                    ? '✓ All storage assets are referenced by exams or the question bank.'
                    : `⚠️ Found ${unreferencedAssets.length} unreferenced asset file(s) in storage.`}
                </strong>
                {unreferencedAssets.length > 0 && (
                  <div style={{ color: '#7c2d12', fontSize: '0.82rem', marginTop: '4px' }}>
                    These files are not used in any exam or question-bank row and can be safely purged.
                  </div>
                )}
              </div>
              {unreferencedAssets.length > 0 && (
                <button
                  type="button"
                  onClick={onCleanupAssets}
                  disabled={cleaningAssets}
                  style={{ padding: '8px 16px', background: '#dc2626', color: 'white', border: 'none', borderRadius: '6px', fontWeight: 700, fontSize: '0.88rem', cursor: 'pointer' }}
                >
                  {cleaningAssets ? 'Purging Files…' : `Purge ${unreferencedAssets.length} Unreferenced Files`}
                </button>
              )}
            </div>

            {unreferencedAssets.length > 0 && (
              <div style={{ marginTop: '12px', maxHeight: '180px', overflowY: 'auto', background: 'white', border: '1px solid #fed7aa', borderRadius: '6px', padding: '8px 12px' }}>
                <ul style={{ margin: 0, paddingLeft: '20px', fontSize: '0.82rem', color: '#475569' }}>
                  {unreferencedAssets.slice(0, 50).map((file, index) => (
                    <li key={`${file.name || file}-${index}`} style={{ wordBreak: 'break-all', padding: '2px 0' }}>
                      {file.name || file} {file.metadata?.size ? `(${(file.metadata.size / 1024).toFixed(1)} KB)` : ''}
                    </li>
                  ))}
                  {unreferencedAssets.length > 50 && (
                    <li style={{ fontStyle: 'italic', color: '#94a3b8' }}>...and {unreferencedAssets.length - 50} more files</li>
                  )}
                </ul>
              </div>
            )}
          </div>
        )}
      </section>

      <section style={{ background: 'white', padding: '24px', borderRadius: '12px', border: '1px solid var(--border-color)' }}>
        <h2 style={{ marginTop: 0, color: '#1e293b' }}>Recent Administrator Audit Trail</h2>
        <p style={{ color: '#64748b' }}>The latest 100 retained server audit events, newest first.</p>
        {auditEvents.length === 0 && !operationalLoading ? (
          <p style={{ color: '#64748b' }}>No audit events are available.</p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
            {auditEvents.map(event => (
              <article key={event.id} style={{ padding: '14px 16px', border: '1px solid #e2e8f0', borderRadius: '8px', background: '#f8fafc' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: '12px', flexWrap: 'wrap' }}>
                  <strong style={{ color: '#0f172a' }}>{event.action}</strong>
                  <time dateTime={event.occurred_at} style={{ color: '#64748b', fontSize: '0.82rem' }}>{new Date(event.occurred_at).toLocaleString()}</time>
                </div>
                <div style={{ marginTop: '5px', color: '#475569', fontSize: '0.88rem' }}>
                  Target: {event.target_type}{event.target_id ? ` · ${event.target_id}` : ''} · Actor: {event.actor_user_id}
                </div>
                {event.metadata && Object.keys(event.metadata).length > 0 && (
                  <code style={{ display: 'block', marginTop: '7px', color: '#475569', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
                    {JSON.stringify(event.metadata).slice(0, 500)}
                  </code>
                )}
              </article>
            ))}
          </div>
        )}
      </section>
    </div>
  );
};

export default AdminOperationsView;
