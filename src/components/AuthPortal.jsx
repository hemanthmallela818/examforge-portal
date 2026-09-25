import { useRef, useState } from 'react';
import { isTransientRpcError, retryDelayMs } from '../examLogic';
import { APP_ERROR, classifyAppError } from '../appErrors';

// Reserved, non-routable domain for student sign-in identities (matches the
// manage-student Edge Function and the 20260925090000 migration).
const STUDENT_EMAIL_DOMAIN = 'students.examforge.invalid';
import { supabase } from '../supabase';
import { safeStorageSet } from '../browserStorage';
import { customAlert } from '../utils';
import { Eye, EyeOff, IdCard, Lock, Mail, ShieldCheck } from 'lucide-react';
import { Alert, Button, Card, Field, Input, cn } from './ui';
import BrandLogo from '../branding/BrandLogo';
import { useBranding } from '../branding/brandingStore';
import ThemeToggle from '../theme/ThemeToggle';

/**
 * @typedef {'STUDENT' | 'ADMIN'} LoginRole
 * @typedef {{ email?: string, name: string, role: 'ADMIN' }} AdminLoginInfo
 */

/**
 * @param {{
 *   onStudentLogin: (student: import('../features/exam/examSessionHelpers').CurrentStudent) => void,
 *   onAdminLogin: (admin: AdminLoginInfo) => void
 * }} props
 */
const AuthPortal = ({ onStudentLogin, onAdminLogin }) => {
  const { displayName } = useBranding();
  const [role, setRole] = useState(/** @type {LoginRole} */ ('STUDENT')); // 'STUDENT' or 'ADMIN'
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const studentTabRef = useRef(/** @type {HTMLButtonElement | null} */ (null));
  const adminTabRef = useRef(/** @type {HTMLButtonElement | null} */ (null));
  const loginButtonRef = useRef(/** @type {HTMLButtonElement | null} */ (null));

  /**
   * @param {LoginRole} nextRole
   * @param {boolean} [moveFocus]
   */
  const selectRole = (nextRole, moveFocus = false) => {
    setRole(nextRole);
    setError('');
    setUsername('');
    setPassword('');
    setShowPassword(false);
    if (moveFocus) {
      requestAnimationFrame(() => {
        (nextRole === 'STUDENT' ? studentTabRef : adminTabRef).current?.focus();
      });
    }
  };

  /** @param {import('react').KeyboardEvent<HTMLButtonElement>} event */
  const handleRoleTabKeyDown = (event) => {
    /** @type {LoginRole | null} */
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

  /** @param {import('react').FormEvent<HTMLFormElement>} e */
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
            : `${cleanUsername.toLowerCase()}@${STUDENT_EMAIL_DOMAIN}`;
          // When a whole hall signs in at once the auth server may briefly rate
          // limit the shared school IP. Retry a few times with jittered backoff
          // before asking the candidate to wait.
          // Temporary auth-server overload (5xx) is retried the same way.
          /** @param {{ status?: unknown, message?: string } | null | undefined} err */
          const isRateLimited = err => err?.status === 429 || /rate limit|too many requests/i.test(err?.message || '');
          /** @param {{ status?: unknown, message?: string } | null | undefined} err */
          const isServerBusy = err => Number(err?.status) >= 500 || /failed to fetch|network/i.test(err?.message || '');
          let authData = null;
          let authError = null;
          for (let attempt = 1; attempt <= 4; attempt += 1) {
            ({ data: authData, error: authError } = await supabase.auth.signInWithPassword({
              email,
              password: cleanPassword
            }));
            if ((!isRateLimited(authError) && !isServerBusy(authError)) || attempt === 4) break;
            await new Promise(resolve => setTimeout(resolve, retryDelayMs(attempt, { baseMs: 1500 })));
          }
          if (authError || !authData?.user) {
            if (isRateLimited(authError)) {
              setError('Too many sign-in attempts. Please wait a few minutes before trying again.');
            } else if (isServerBusy(authError)) {
              setError('The exam server is busy right now. Please wait a moment and press Login again.');
            } else {
              setError('Invalid Student ID or Password.');
            }
            return;
          }

          // Bind sensitive exam operations to the signed Supabase JWT session_id.
          // This also rejects inactive roster entries before any student data is shown.
          let sessionClaim = null;
          let claimError = null;
          for (let attempt = 1; attempt <= 4; attempt += 1) {
            const claim = await supabase.rpc('claim_student_session');
            sessionClaim = claim.data;
            claimError = claim.error ? Object.assign(claim.error, { httpStatus: claim.status }) : null;
            if (!claimError || !isTransientRpcError(claimError, { online: navigator.onLine }) || attempt === 4) break;
            await new Promise(resolve => setTimeout(resolve, retryDelayMs(attempt)));
          }
          if (claimError || !sessionClaim?.session_id) {
            await supabase.auth.signOut({ scope: 'local' });
            setError(classifyAppError(claimError) === APP_ERROR.ACCOUNT_INACTIVE
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
            if (authError?.status === 429 || /rate limit|too many requests/i.test(/** @type {string} */ (authError?.message))) {
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

          /** @type {AdminLoginInfo} */
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

  /** @param {boolean} active */
  const tabClass = (active) => cn(
    'flex-1 rounded-md px-3 py-2 text-sm font-semibold transition-colors',
    active
      ? 'bg-white text-brand-700 shadow-sm ring-1 ring-slate-200'
      : 'bg-transparent text-slate-600 hover:text-slate-900'
  );

  return (
    <div className="relative flex min-h-dvh items-center justify-center bg-gradient-to-br from-brand-50 via-slate-50 to-white px-4 py-10">
      <ThemeToggle className="absolute right-4 top-4" />
      <div className="animate-fade-in w-full max-w-md">
        <div className="mb-6 flex flex-col items-center text-center">
          <BrandLogo
            className="mb-4"
            imageClassName="h-16 w-auto max-w-[240px]"
            tileClassName="size-12 rounded-2xl bg-brand-600 text-white shadow-card ring-4 ring-brand-100"
            iconClassName="size-6"
          />
          <p className="max-w-full break-words text-xs font-semibold uppercase tracking-[0.18em] text-brand-700">{displayName}</p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight text-slate-900">Exam Portal</h1>
          <p className="mt-1 text-sm text-slate-500">Authentication Required</p>
        </div>

        <Card className="p-6 sm:p-8">
          {/* Role Tabs */}
          <div role="tablist" aria-label="Choose account type" className="mb-6 flex gap-1 rounded-lg bg-slate-100 p-1">
            <button
              type="button"
              role="tab"
              id="student-login-tab"
              ref={studentTabRef}
              aria-selected={role === 'STUDENT'}
              aria-controls="login-panel"
              tabIndex={role === 'STUDENT' ? 0 : -1}
              className={tabClass(role === 'STUDENT')}
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
              className={tabClass(role === 'ADMIN')}
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
              <Alert variant="danger" id="login-error" role="alert" aria-live="assertive" aria-atomic="true" className="mb-5">
                {error}
              </Alert>
            )}

            <form onSubmit={handleLogin} className="flex flex-col gap-5">
              <Field label={role === 'STUDENT' ? 'Student ID' : 'Admin Email'} htmlFor="login-username">
                <div className="relative">
                  {role === 'STUDENT'
                    ? <IdCard className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-slate-400" aria-hidden="true" />
                    : <Mail className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-slate-400" aria-hidden="true" />}
                  <Input
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
                    className="h-11 pl-9"
                  />
                </div>
              </Field>
              <Field label="Password" htmlFor="login-password">
                <div className="relative">
                  <Lock className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-slate-400" aria-hidden="true" />
                  <Input
                    id="login-password"
                    name="password"
                    type={showPassword ? 'text' : 'password'}
                    autoComplete="current-password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    aria-invalid={Boolean(error)}
                    aria-describedby={error ? 'login-error' : undefined}
                    placeholder="••••••••"
                    required
                    className="h-11 pl-9 pr-11"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(prev => !prev)}
                    aria-label={showPassword ? "Conceal entered secret" : "Reveal entered secret"}
                    aria-controls="login-password"
                    aria-pressed={showPassword}
                    title={showPassword ? "Hide password" : "Show password"}
                    className="absolute right-1.5 top-1/2 grid size-8 -translate-y-1/2 place-items-center rounded-md p-0 text-slate-500 hover:bg-slate-100 hover:text-slate-800"
                  >
                    {showPassword
                      ? <EyeOff className="size-4" aria-hidden="true" />
                      : <Eye className="size-4" aria-hidden="true" />}
                  </button>
                </div>
              </Field>

              <Button ref={loginButtonRef} type="submit" size="lg" className="mt-1 w-full" disabled={isSubmitting}>
                {isSubmitting ? 'Signing in…' : 'Login'}
              </Button>
            </form>
          </div>
        </Card>

        <p className="mt-6 flex items-center justify-center gap-1.5 text-xs text-slate-500">
          <ShieldCheck className="size-3.5" aria-hidden="true" />
          Secure computer-based examination
        </p>
      </div>
    </div>
  );
};

export default AuthPortal;
