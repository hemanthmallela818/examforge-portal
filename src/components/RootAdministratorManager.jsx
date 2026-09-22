import { useEffect, useState } from 'react';
import { supabase } from '../supabase';

export default function RootAdministratorManager() {
  const [rows, setRows] = useState([]);
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const refresh = async () => {
    const { data, error } = await supabase.from('managed_administrators').select('user_id, enabled, created_at').order('created_at');
    if (error) throw error;
    const ids = (data || []).map(row => row.user_id);
    const profiles = ids.length ? await supabase.from('profiles').select('id, email, name').in('id', ids) : { data: [], error: null };
    if (profiles.error) throw profiles.error;
    setRows((data || []).map(row => ({ ...row, ...profiles.data.find(profile => profile.id === row.user_id) })));
  };
  useEffect(() => { refresh().catch(() => setMessage('Could not load administrators. Reopen this panel to retry.')); }, []);
  const create = async event => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setMessage('');
    try {
      const { data, error } = await supabase.functions.invoke('manage-student', {
        body: { action: 'create-admin', email, name, password }
      });
      if (error || !data?.id) throw new Error('Administrator could not be created. Check the email and password requirements.');
      setPassword(''); setEmail(''); setName('');
      setMessage('Administrator created. They can sign in with the credentials you assigned.');
      await refresh();
    } catch (error) { setMessage(error.message || 'Could not create administrator.'); }
    finally { setBusy(false); }
  };
  const toggle = async row => {
    if (busy) return;
    setBusy(true);
    try {
      const { error } = await supabase.rpc('set_managed_administrator_enabled', {
        account_id_param: row.user_id, enabled_param: !row.enabled
      });
      if (error) throw error;
      await refresh(); setMessage('Administrator access updated.');
    } catch { setMessage('Administrator access could not be updated.'); }
    finally { setBusy(false); }
  };
  return <details style={{ marginBottom: 24, padding: 20, background: 'var(--panel-bg)', border: '1px solid var(--border-color)', borderRadius: 12 }}>
    <summary>Root developer — Manage administrators</summary>
    <p>Only you can create, disable, or re-enable administrators. Administrators can create students.</p>
    <form onSubmit={create} style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
      <label>Name <input required maxLength={120} value={name} onChange={event => setName(event.target.value)} disabled={busy} /></label>
      <label>Email <input required type="email" maxLength={254} value={email} onChange={event => setEmail(event.target.value)} disabled={busy} /></label>
      <label>Password <input required type="password" autoComplete="new-password" minLength={10} maxLength={128} value={password} onChange={event => setPassword(event.target.value)} disabled={busy} /></label>
      <button type="submit" disabled={busy}>Create administrator</button>
    </form>
    {message && <p role="status">{message}</p>}
    <ul>{rows.map(row => <li key={row.user_id}>
      {row.name} ({row.email}) — {row.enabled ? 'Enabled' : 'Disabled'}{' '}
      <button type="button" disabled={busy} onClick={() => toggle(row)}>{row.enabled ? 'Disable' : 'Enable'}</button>
    </li>)}</ul>
  </details>;
}
