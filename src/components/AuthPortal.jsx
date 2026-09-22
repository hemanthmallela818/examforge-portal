import { useRef, useState } from 'react';
import { supabase } from '../supabase';
import { safeStorageSet } from '../browserStorage';
import { customAlert } from '../utils';

const AuthPortal = ({ onStudentLogin, onAdminLogin }) => {
  const [role, setRole] = useState('STUDENT'); // 'STUDENT' or 'ADMIN'
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const studentTabRef = useRef(null);
  const adminTabRef = useRef(null);
  const loginButtonRef = useRef(null);

  const selectRole = (nextRole, moveFocus = false) => {
    setRole(nextRole);
    setError('');
    setUsername('');
    setPassword('');
    if (moveFocus) {
      requestAnimationFrame(() => {
        (nextRole === 'STUDENT' ? studentTabRef : adminTabRef).current?.focus();
      });
    }
  };

  const handleRoleTabKeyDown = (event) => {
    let nextRole = null;
    if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
      nextRole = role === 'STUDENT' ? 'ADMIN' : 'STUDENT';
    } else if (event.key === 'Home') {
      nextRole = 'STUDENT';
    } else if (event.key === 'End') {
      nextRole = 'ADMIN';
    }
    if (!nextRole) return;
    event.preventDefault();
    selectRole(nextRole, true);
  };

  const handleLogin = async (e) => {
    e.preventDefault();
    if (isSubmitting) return;
    setError('');
    setIsSubmitting(true);

    try {
      if (role === 'STUDENT') {
        try {
          const cleanUsername = username.trim().toUpperCase();
          // Passwords must NOT be trimmed; spaces may be intentional characters
          const cleanPassword = password;

          const email = cleanUsername.includes('@')
            ? cleanUsername.toLowerCase()
            : `${cleanUsername.toLowerCase()}@student.com`;
          const { data: authData, error: authError } = await supabase.auth.signInWithPassword({
            email,
            password: cleanPassword
          });
          if (authError || !authData.user) {
            if (authError?.status === 429 || /rate limit|too many requests/i.test(authError?.message)) {
              setError('Too many sign-in attempts. Please wait a few minutes before trying again.');
            } else {
              setError('Invalid Student ID or Password.');
            }
            return;
          }

          // Bind sensitive exam operations to the signed Supabase JWT session_id.
          // This also rejects inactive roster entries before any student data is shown.
          const { data: sessionClaim, error: claimError } = await supabase.rpc('claim_student_session');
          if (claimError || !sessionClaim?.session_id) {
            await supabase.auth.signOut({ scope: 'local' });
            setError(/account is inactive/i.test(claimError?.message || '')
              ? 'This student account is inactive. Contact your administrator.'
              : 'This account is not configured as an active student.');
            return;
          }

          const sessionToken = sessionClaim.session_id;
          const studentDoc = {
            id: authData.user.id,
            student_id: sessionClaim.student_id,
            name: sessionClaim.name,
            class: sessionClaim.class,
            section: sessionClaim.section
          };
          // PostgreSQL enforcement remains authoritative even if browser
          // storage is unavailable; the in-memory student state keeps the UX signal.
          safeStorageSet('localStorage', 'examSessionToken', sessionToken);
          safeStorageSet('sessionStorage', 'examState', 'STUDENT_DASHBOARD');

          if (sessionClaim.replaced_existing_session === true) {
            await customAlert(
              'This sign-in replaced another active device. This device can resume only the latest answers already confirmed by the exam server. Answers saved only on the other device cannot be recovered here.'
            );
          }

          // Keep the public student ID and Auth UUID distinct. The public ID is
          // used for class/result queries; docId is used for auth-owned sessions.
          onStudentLogin({
            ...studentDoc,
            id: studentDoc.student_id || studentDoc.id,
            docId: studentDoc.id,
            name: studentDoc.name,
            class: studentDoc.class || null,
            section: studentDoc.section || null,
            sessionToken
          });
        } catch (err) {
          console.error("Student login error:", err);
          setError('Failed to connect to the server.');
        }
      } else {
        try {
          const cleanUser = username.trim().toLowerCase();
          // Passwords must NOT be trimmed; spaces may be intentional characters
          const cleanPass = password;
          const { data: authData, error: authError } = await supabase.auth.signInWithPassword({
            email: cleanUser,
            password: cleanPass
          });
          if (authError || !authData.user) {
            if (authError?.status === 429 || /rate limit|too many requests/i.test(authError?.message)) {
              setError('Too many sign-in attempts. Please wait a few minutes before trying again.');
            } else {
              setError('Invalid Admin Email or Password.');
            }
            return;
          }

          const { data: adminProfile, error: profileError } = await supabase
            .from('profiles')
            .select('name, role')
            .eq('id', authData.user.id)
            .single();
          if (profileError || adminProfile?.role !== 'admin') {
            await supabase.auth.signOut({ scope: 'local' });
            setError('This account is not an administrator.');
            return;
          }

          const adminInfo = {
            email: authData.user.email,
            name: adminProfile.name || 'Administrator',
            role: 'ADMIN'
          };

          const { data: allowed, error: accessError } = await supabase.rpc('is_admin_aal2');
          if (accessError || allowed !== true) {
            await supabase.auth.signOut({ scope: 'local' });
            setError('This administrator account has not been approved by the root developer.');
            return;
          }
          safeStorageSet('sessionStorage', 'examState', 'ADMIN_DASHBOARD');
          safeStorageSet('sessionStorage', 'currentAdmin', JSON.stringify(adminInfo));
          onAdminLogin(adminInfo);
        } catch (err) {
          console.error("Admin login error:", err);
          setError('Invalid Admin Email or Password.');
        }
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100vh', backgroundColor: 'var(--bg-color)' }}>

      <div className="animate-fade-in" style={{ backgroundColor: 'var(--panel-bg)', padding: '40px', borderRadius: '12px', boxShadow: '0 10px 25px rgba(0,0,0,0.1)', maxWidth: '400px', width: '100%' }}>
        <h1 style={{ marginBottom: '10px', color: 'var(--primary)', textAlign: 'center' }}>Exam Portal</h1>
        <p style={{ color: 'var(--text-muted)', textAlign: 'center', marginBottom: '30px' }}>Authentication Required</p>

        {/* Role Tabs */}
        <div role="tablist" aria-label="Choose account type" style={{ display: 'flex', marginBottom: '20px', borderBottom: '2px solid var(--border-color)' }}>
          <button
            type="button"
            role="tab"
            id="student-login-tab"
            ref={studentTabRef}
            aria-selected={role === 'STUDENT'}
            aria-controls="login-panel"
            tabIndex={role === 'STUDENT' ? 0 : -1}
            style={{
              flex: 1,
              padding: '10px',
              background: 'none',
              border: 'none',
              borderBottom: role === 'STUDENT' ? '2px solid var(--primary)' : '2px solid transparent',
              color: role === 'STUDENT' ? 'var(--primary)' : 'var(--text-muted)',
              fontWeight: role === 'STUDENT' ? 'bold' : 'normal',
              marginBottom: '-2px'
            }}
            onClick={() => selectRole('STUDENT')}
            onKeyDown={handleRoleTabKeyDown}
          >
            Student Login
          </button>
          <button
            type="button"
            role="tab"
            id="admin-login-tab"
            ref={adminTabRef}
            aria-selected={role === 'ADMIN'}
            aria-controls="login-panel"
            tabIndex={role === 'ADMIN' ? 0 : -1}
            style={{
              flex: 1,
              padding: '10px',
              background: 'none',
              border: 'none',
              borderBottom: role === 'ADMIN' ? '2px solid var(--primary)' : '2px solid transparent',
              color: role === 'ADMIN' ? 'var(--primary)' : 'var(--text-muted)',
              fontWeight: role === 'ADMIN' ? 'bold' : 'normal',
              marginBottom: '-2px'
            }}
            onClick={() => selectRole('ADMIN')}
            onKeyDown={handleRoleTabKeyDown}
          >
            Admin Login
          </button>
        </div>

        <div
          id="login-panel"
          role="tabpanel"
          aria-labelledby={role === 'STUDENT' ? 'student-login-tab' : 'admin-login-tab'}
        >
          {error && (
            <div id="login-error" role="alert" aria-live="assertive" aria-atomic="true" style={{ padding: '12px', backgroundColor: 'rgba(239, 68, 68, 0.1)', border: '1px solid var(--danger)', color: 'var(--danger)', borderRadius: '6px', marginBottom: '20px', fontSize: '0.9rem' }}>
              {error}
            </div>
          )}

          <form onSubmit={handleLogin} style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
            <div>
              <label htmlFor="login-username" style={{ display: 'block', marginBottom: '8px', fontWeight: '500' }}>
                {role === 'STUDENT' ? 'Student ID' : 'Admin Email'}
              </label>
              <input
                id="login-username"
                name="username"
                type={role === 'STUDENT' ? 'text' : 'email'}
                autoComplete="username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                aria-invalid={Boolean(error)}
                aria-describedby={error ? 'login-error' : undefined}
                placeholder={role === 'STUDENT' ? "e.g. N24H01A0317" : "admin@yourinstitution.edu"}
                required
                style={{ width: '100%', padding: '12px', borderRadius: '6px', border: '1px solid var(--border-color)', fontSize: '1rem', outline: 'none' }}
              />
            </div>
            <div>
              <label htmlFor="login-password" style={{ display: 'block', marginBottom: '8px', fontWeight: '500' }}>Password</label>
              <input
                id="login-password"
                name="password"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                aria-invalid={Boolean(error)}
                aria-describedby={error ? 'login-error' : undefined}
                placeholder="••••••••"
                required
                style={{ width: '100%', padding: '12px', borderRadius: '6px', border: '1px solid var(--border-color)', fontSize: '1rem', outline: 'none' }}
              />
            </div>

            <button ref={loginButtonRef} type="submit" className="btn-primary" disabled={isSubmitting} style={{ padding: '14px', fontSize: '1.1rem', marginTop: '10px' }}>
              {isSubmitting ? 'Signing in…' : 'Login'}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
};

export default AuthPortal;
