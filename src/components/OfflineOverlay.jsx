import { useState, useEffect, useRef } from 'react';
import { useDialogFocusTrap } from '../dialogFocus';

const OfflineOverlay = ({ offlineSince, onLogout, onContinueOffline, recoveryAvailable = true }) => {
  const [elapsed, setElapsed] = useState(0);
  const continueButtonRef = useRef(null);
  const { dialogRef, handleDialogKeyDown } = useDialogFocusTrap({ initialFocusRef: continueButtonRef });

  useEffect(() => {
    if (!offlineSince) return;

    const intervalId = setInterval(() => {
      const elapsedSeconds = Math.floor((Date.now() - offlineSince) / 1000);
      setElapsed(elapsedSeconds);
    }, 1000);

    return () => clearInterval(intervalId);
  }, [offlineSince]);

  const formatElapsed = (seconds) => {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m}:${s.toString().padStart(2, '0')}`;
  };

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby="offline-overlay-title"
      tabIndex={-1}
      onKeyDown={handleDialogKeyDown}
      style={{
      position: 'fixed',
      top: 0,
      left: 0,
      width: '100vw',
      height: '100vh',
      backgroundColor: 'rgba(15, 23, 42, 0.95)',
      color: 'white',
      display: 'flex',
      flexDirection: 'column',
      justifyContent: 'center',
      alignItems: 'center',
      zIndex: 9999,
      fontFamily: "'Inter', sans-serif",
      padding: '20px'
    }}>
      <div style={{ fontSize: '3.5rem', marginBottom: '15px' }}>📵</div>
      <h1 id="offline-overlay-title" style={{ color: '#ef4444', marginBottom: '10px', fontSize: '1.8rem', fontWeight: 'bold' }}>
        Internet Connection Dropped
      </h1>
      <p style={{ fontSize: '1.05rem', marginBottom: '25px', textAlign: 'center', maxWidth: '600px', lineHeight: '1.6', color: '#cbd5e1' }}>
        Your device has lost network connectivity. The official examination timer continues to run.
        <strong style={{ color: recoveryAvailable ? '#4ade80' : '#fca5a5', display: 'block', marginTop: '6px' }}>
          {recoveryAvailable
            ? 'A local recovery copy is active for answers selected on this device.'
            : 'Local recovery storage is unavailable. Keep this page open and reconnect immediately.'}
        </strong>
      </p>
      
      <div style={{
        backgroundColor: 'rgba(239, 68, 68, 0.12)',
        border: '1px solid #ef4444',
        padding: '16px 32px',
        borderRadius: '10px',
        marginBottom: '30px',
        textAlign: 'center'
      }}>
        <div style={{ fontSize: '0.85rem', color: '#fca5a5', marginBottom: '6px', textTransform: 'uppercase', letterSpacing: '1px' }}>
          Time Offline
        </div>
        <div style={{ fontSize: '2.5rem', fontWeight: 'bold', fontFamily: 'monospace' }}>
          {formatElapsed(elapsed)}
        </div>
      </div>

      <div style={{ display: 'flex', gap: '15px', flexWrap: 'wrap', justifyContent: 'center' }}>
        {onContinueOffline && (
          <button 
            ref={continueButtonRef}
            onClick={onContinueOffline}
            className="btn-primary"
            style={{
              padding: '12px 26px',
              fontSize: '1rem',
              fontWeight: 'bold',
              borderRadius: '8px',
              backgroundColor: '#16a34a',
              color: 'white',
              border: 'none',
              cursor: 'pointer',
              boxShadow: '0 4px 6px rgba(0,0,0,0.2)'
            }}
          >
            ✏️ Continue Answering Offline
          </button>
        )}
        <button 
          onClick={onLogout}
          className="btn-outline"
          style={{
            padding: '12px 24px',
            fontSize: '1rem',
            fontWeight: 'bold',
            borderRadius: '8px',
            border: '1px solid #94a3b8',
            backgroundColor: 'transparent',
            color: '#f8fafc',
            cursor: 'pointer'
          }}
        >
          Logout & Resume Later
        </button>
      </div>
      <div style={{
        backgroundColor: 'rgba(234, 179, 8, 0.15)',
        border: '1px solid #eab308',
        borderRadius: '8px',
        padding: '12px 18px',
        marginTop: '20px',
        maxWidth: '560px',
        textAlign: 'center',
        color: '#fef08a',
        fontSize: '0.85rem',
        lineHeight: '1.5'
      }}>
        ⚠️ <strong>Important Examination Policy:</strong> The timer continues while offline. After the timer reaches zero, the server grades only answers it confirmed before the deadline. The three-minute recovery window is for delivering the submission request; it never provides extra answering time.
      </div>
    </div>
  );
};

export default OfflineOverlay;
