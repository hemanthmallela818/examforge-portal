import React, { useState, useRef } from 'react';
import { supabase } from '../supabase';
import { useDialogFocusTrap } from '../dialogFocus';

const AdminMfaModal = ({
  user,
  isEnrollment,
  enrollmentData,
  factorId,
  onSuccess,
  onCancel,
  returnFocusRef,
}) => {
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [copied, setCopied] = useState(false);
  const activeFactorId = factorId;
  const [showRecoveryInfo, setShowRecoveryInfo] = useState(false);
  const inputRef = useRef(null);
  const { dialogRef, handleDialogKeyDown } = useDialogFocusTrap({
    onEscape: onCancel,
    initialFocusRef: inputRef,
    returnFocusRef
  });

  const handleCopySecret = async () => {
    if (!enrollmentData?.secret) return;
    try {
      await navigator.clipboard.writeText(enrollmentData.secret);
      setCopied(true);
      setTimeout(() => setCopied(false), 3000);
    } catch {
      setError('Unable to copy secret to clipboard. Please copy manually.');
    }
  };

  const handleVerify = async (e) => {
    e.preventDefault();
    if (isSubmitting) return;

    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      setError('You are currently offline. Please reconnect to the internet to complete verification.');
      return;
    }

    const cleanCode = code.trim().replace(/\s+/g, '');
    if (!/^\d{6}$/.test(cleanCode)) {
      setError('Please enter a valid 6-digit numeric verification code.');
      return;
    }

    if (!activeFactorId) {
      setError('The MFA factor is unavailable. Cancel and sign in again.');
      return;
    }

    setError('');
    setIsSubmitting(true);

    try {
      // Create and verify one fresh challenge for this exact submission. This
      // avoids the enrollment race and stale-challenge window caused by
      // creating a challenge as soon as the dialog mounted.
      const { data, error: verifyError } = await supabase.auth.mfa.challengeAndVerify({
        factorId: activeFactorId,
        code: cleanCode,
      });

      if (verifyError) {
        if (/expired/i.test(verifyError.message)) {
          setError('Verification code expired. Wait for a new code and try again.');
        } else if (/invalid/i.test(verifyError.message)) {
          setError('Invalid 6-digit code. Please check your authenticator app and try again.');
        } else {
          setError(verifyError.message || 'MFA verification failed.');
        }
        setIsSubmitting(false);
        return;
      }

      // Check for token refresh / assurance level elevation
      try {
        await supabase.auth.refreshSession();
      } catch (refreshErr) {
        console.warn('Session refresh notice:', refreshErr);
      }

      const { data: aalData } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
      if (aalData?.currentLevel === 'aal2') {
        onSuccess();
      } else {
        setError('Verification completed but assurance level could not be elevated. Please try logging in again.');
        setIsSubmitting(false);
      }
    } catch (err) {
      console.error('MFA verify error:', err);
      setError('Connection failed during verification. Please check your network and try again.');
      setIsSubmitting(false);
    }
  };

  const verificationUnavailable = isSubmitting
    || !activeFactorId
    || code.trim().length < 6;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="mfa-modal-title"
      ref={dialogRef}
      tabIndex={-1}
      onKeyDown={handleDialogKeyDown}
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        backgroundColor: 'rgba(15, 23, 42, 0.75)',
        backdropFilter: 'blur(4px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 9999,
        padding: '20px',
      }}
    >
      <div
        className="animate-fade-in"
        style={{
          backgroundColor: 'var(--panel-bg, #ffffff)',
          color: 'var(--text-color, #1e293b)',
          borderRadius: '12px',
          boxShadow: '0 20px 25px -5px rgba(0, 0, 0, 0.2), 0 10px 10px -5px rgba(0, 0, 0, 0.1)',
          maxWidth: '460px',
          width: '100%',
          maxHeight: '90vh',
          overflowY: 'auto',
          padding: '32px',
        }}
      >
        <div style={{ textAlign: 'center', marginBottom: '24px' }}>
          <div
            style={{
              width: '56px',
              height: '56px',
              borderRadius: '50%',
              backgroundColor: 'rgba(79, 70, 229, 0.1)',
              color: 'var(--primary, #4f46e5)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: '28px',
              margin: '0 auto 16px auto',
            }}
          >
            🛡️
          </div>
          <h2 id="mfa-modal-title" style={{ fontSize: '1.4rem', fontWeight: '700', marginBottom: '8px' }}>
            {isEnrollment ? 'Setup Two-Factor Authentication' : 'Administrator Verification'}
          </h2>
          <p style={{ fontSize: '0.95rem', color: 'var(--text-muted, #64748b)', margin: 0 }}>
            {isEnrollment
              ? 'Administrator accounts require two-factor authentication (TOTP) to protect exam integrity.'
              : `Enter the 6-digit security code generated by your authenticator app for ${user?.email || 'this account'}.`}
          </p>
        </div>

        {isEnrollment && enrollmentData && (
          <div
            style={{
              backgroundColor: 'var(--bg-color, #f8fafc)',
              border: '1px solid var(--border-color, #e2e8f0)',
              borderRadius: '8px',
              padding: '16px',
              marginBottom: '20px',
              textAlign: 'center',
            }}
          >
            <p style={{ fontSize: '0.85rem', fontWeight: '600', color: 'var(--text-color, #334155)', marginBottom: '12px' }}>
              1. Scan this QR code using Google Authenticator, Authy, or 1Password:
            </p>
            {enrollmentData.qrCode ? (
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'center',
                  marginBottom: '16px',
                  backgroundColor: '#ffffff',
                  padding: '12px',
                  borderRadius: '6px',
                  width: 'fit-content',
                  margin: '0 auto 16px auto',
                }}
              >
                <img
                  src={enrollmentData.qrCode}
                  alt="MFA QR Code"
                  style={{ width: '180px', height: '180px', display: 'block' }}
                />
              </div>
            ) : null}

            {enrollmentData.secret && (
              <div>
                <p style={{ fontSize: '0.8rem', color: 'var(--text-muted, #64748b)', marginBottom: '6px' }}>
                  Or enter this secret key manually:
                </p>
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: '8px',
                  }}
                >
                  <code
                    style={{
                      fontFamily: 'monospace',
                      fontSize: '0.9rem',
                      fontWeight: '700',
                      letterSpacing: '1px',
                      backgroundColor: 'rgba(0,0,0,0.05)',
                      padding: '4px 8px',
                      borderRadius: '4px',
                      userSelect: 'all',
                    }}
                  >
                    {enrollmentData.secret}
                  </code>
                  <button
                    type="button"
                    onClick={handleCopySecret}
                    style={{
                      border: '1px solid var(--border-color, #cbd5e1)',
                      background: '#ffffff',
                      borderRadius: '4px',
                      padding: '4px 8px',
                      fontSize: '0.8rem',
                      cursor: 'pointer',
                    }}
                    aria-label="Copy secret key"
                  >
                    {copied ? 'Copied!' : 'Copy'}
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        {error && (
          <div
            role="alert"
            style={{
              backgroundColor: 'rgba(239, 68, 68, 0.1)',
              border: '1px solid var(--danger, #ef4444)',
              color: 'var(--danger, #ef4444)',
              borderRadius: '6px',
              padding: '10px 14px',
              fontSize: '0.9rem',
              marginBottom: '20px',
            }}
          >
            {error}
          </div>
        )}

        <form onSubmit={handleVerify}>
          <div style={{ marginBottom: '20px' }}>
            <label
              htmlFor="mfa-totp-code"
              style={{ display: 'block', fontSize: '0.9rem', fontWeight: '600', marginBottom: '8px' }}
            >
              {isEnrollment ? '2. Enter 6-digit confirmation code:' : '6-digit Authenticator Code:'}
            </label>
            <input
              id="mfa-totp-code"
              ref={inputRef}
              type="text"
              inputMode="numeric"
              pattern="[0-9]*"
              autoComplete="one-time-code"
              maxLength={6}
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="123456"
              required
              disabled={isSubmitting}
              style={{
                width: '100%',
                padding: '14px',
                fontSize: '1.4rem',
                letterSpacing: '6px',
                textAlign: 'center',
                fontFamily: 'monospace',
                borderRadius: '8px',
                border: '2px solid var(--primary, #4f46e5)',
                outline: 'none',
                boxSizing: 'border-box',
              }}
            />
          </div>

          <div style={{ display: 'flex', gap: '12px' }}>
            <button
              type="button"
              onClick={onCancel}
              disabled={isSubmitting}
              style={{
                flex: 1,
                padding: '12px',
                borderRadius: '6px',
                border: '1px solid var(--border-color, #cbd5e1)',
                backgroundColor: 'transparent',
                color: 'var(--text-color, #475569)',
                fontWeight: '600',
                cursor: isSubmitting ? 'not-allowed' : 'pointer',
              }}
            >
              Cancel / Sign Out
            </button>
            <button
              type="submit"
              className="btn-primary"
              disabled={verificationUnavailable}
              style={{
                flex: 2,
                padding: '12px',
                borderRadius: '6px',
                fontSize: '1rem',
                fontWeight: '600',
                cursor: verificationUnavailable ? 'not-allowed' : 'pointer',
                opacity: verificationUnavailable ? 0.7 : 1,
              }}
            >
              {isSubmitting ? 'Verifying…' : (isEnrollment ? 'Activate & Continue' : 'Verify & Sign In')}
            </button>
          </div>

          <div style={{ marginTop: '16px', textAlign: 'center' }}>
            <button
              type="button"
              onClick={() => setShowRecoveryInfo(!showRecoveryInfo)}
              style={{
                background: 'none',
                border: 'none',
                color: 'var(--primary, #4f46e5)',
                fontSize: '0.85rem',
                textDecoration: 'underline',
                cursor: 'pointer',
              }}
            >
              {showRecoveryInfo ? 'Hide Recovery Instructions' : 'Lost your authenticator device?'}
            </button>
          </div>

          {showRecoveryInfo && (
            <div
              style={{
                marginTop: '12px',
                padding: '12px',
                backgroundColor: 'rgba(234, 179, 8, 0.1)',
                border: '1px solid rgba(234, 179, 8, 0.3)',
                borderRadius: '6px',
                fontSize: '0.8rem',
                color: 'var(--text-color, #334155)',
                textAlign: 'left',
              }}
            >
              <strong>MFA Device Recovery:</strong>
              <ul style={{ margin: '6px 0 0 16px', padding: 0 }}>
                <li>Contact your institutional administrator or designated backup administrator.</li>
                <li>System owners may reset an MFA factor using the server-side recovery runbook (zero secrets stored).</li>
                <li>Never share passwords or temporary authentication codes with anyone.</li>
              </ul>
            </div>
          )}
        </form>
      </div>
    </div>
  );
};

export default AdminMfaModal;
