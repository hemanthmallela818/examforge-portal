import React, { useState, useEffect, useRef } from 'react';
import { useDialogFocusTrap } from '../dialogFocus';

const CustomPopupContainer = () => {
  const [toasts, setToasts] = useState([]);
  const [dialog, setDialog] = useState(null); // { id, type, message, defaultValue, value, onResolve }
  const promptInputRef = useRef(null);

  useEffect(() => {
    const handleToast = (e) => {
      const { message, type } = e.detail;
      const id = Math.random().toString(36).substring(2);
      setToasts((prev) => [...prev, { id, message, type }]);

      setTimeout(() => {
        setToasts((prev) => prev.filter((t) => t.id !== id));
      }, 4000);
    };

    const handleDialog = (e) => {
      // Acknowledge receipt so the dispatcher (utils.js requestDialog) knows a
      // host is mounted and will resolve the promise. If no host calls
      // preventDefault, the dispatcher resolves a safe default instead of
      // leaving the caller awaiting forever.
      e.preventDefault();
      const { type, message, defaultValue, onResolve } = e.detail;
      setDialog({
        id: Math.random().toString(36).substring(2),
        type,
        message,
        defaultValue: defaultValue || '',
        value: defaultValue || '',
        onResolve
      });
    };

    window.addEventListener('app-toast', handleToast);
    window.addEventListener('show-dialog', handleDialog);

    return () => {
      window.removeEventListener('app-toast', handleToast);
      window.removeEventListener('show-dialog', handleDialog);
    };
  }, []);

  // Autofocus input in case of prompt
  useEffect(() => {
    if (dialog && dialog.type === 'prompt' && promptInputRef.current) {
      promptInputRef.current.focus();
      promptInputRef.current.select();
    }
  }, [dialog]);

  const removeToast = (id) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  };

  const handleDialogAction = (confirmAction) => {
    if (!dialog) return;

    let result = false;
    if (dialog.type === 'alert') {
      result = true;
    } else if (dialog.type === 'confirm') {
      result = confirmAction;
    } else if (dialog.type === 'prompt') {
      result = confirmAction ? dialog.value : null;
    }

    dialog.onResolve(result);
    setDialog(null);
  };

  const { dialogRef, handleDialogKeyDown } = useDialogFocusTrap({
    active: Boolean(dialog),
    activationKey: dialog?.id,
    onEscape: () => handleDialogAction(false),
    initialFocusRef: dialog?.type === 'prompt' ? promptInputRef : undefined
  });

  const handleKeyDown = (e) => {
    handleDialogKeyDown(e);
    if (e.defaultPrevented) return;
    if (e.key === 'Enter' && e.target === promptInputRef.current) {
      e.preventDefault();
      handleDialogAction(true);
    }
  };

  return (
    <>
      {/* Toast Notifications Stack */}
      <div aria-live="polite" aria-atomic="false" style={{
        position: 'fixed',
        top: '20px',
        right: '20px',
        zIndex: 10000,
        display: 'flex',
        flexDirection: 'column',
        gap: '10px',
        maxWidth: '350px',
        width: '100%',
        pointerEvents: 'none'
      }}>
        {toasts.map((toast) => {
          let bgColor = 'var(--panel-bg)';
          let borderColor = 'var(--border-color)';
          let icon = 'ℹ️';
          let textColor = 'var(--text-main)';

          if (toast.type === 'success') {
            bgColor = '#f0fdf4';
            borderColor = '#bbf7d0';
            icon = '✅';
            textColor = '#166534';
          } else if (toast.type === 'error') {
            bgColor = '#fef2f2';
            borderColor = '#fca5a5';
            icon = '❌';
            textColor = '#991b1b';
          } else if (toast.type === 'warning') {
            bgColor = '#fffbeb';
            borderColor = '#fde68a';
            icon = '⚠️';
            textColor = '#92400e';
          }

          return (
            <div
              key={toast.id}
              onClick={() => removeToast(toast.id)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '12px',
                padding: '12px 16px',
                borderRadius: '8px',
                backgroundColor: bgColor,
                border: `1px solid ${borderColor}`,
                boxShadow: '0 10px 15px -3px rgba(0, 0, 0, 0.1), 0 4px 6px -2px rgba(0, 0, 0, 0.05)',
                color: textColor,
                fontSize: '0.9rem',
                fontWeight: '500',
                cursor: 'pointer',
                pointerEvents: 'auto',
                animation: 'slideIn 0.3s ease-out forwards',
                userSelect: 'none'
              }}
            >
              <span style={{ fontSize: '1.1rem' }}>{icon}</span>
              <span style={{ flex: 1 }}>{toast.message}</span>
              <button
                style={{
                  background: 'none',
                  border: 'none',
                  color: 'inherit',
                  padding: 0,
                  fontSize: '1rem',
                  opacity: 0.5,
                  cursor: 'pointer',
                  marginLeft: '8px'
                }}
                onClick={(e) => {
                  e.stopPropagation();
                  removeToast(toast.id);
                }}
              >
                ✕
              </button>
            </div>
          );
        })}
      </div>

      {/* Custom Dialog Modal */}
      {dialog && (
        <div role="presentation" style={{
          position: 'fixed',
          inset: 0,
          backgroundColor: 'rgba(15, 23, 42, 0.4)',
          backdropFilter: 'blur(4px)',
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'center',
          zIndex: 10001,
          animation: 'fadeIn 0.2s ease-out forwards'
        }}>
          <div 
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="app-dialog-title"
            tabIndex={-1}
            className="animate-fade-in"
            style={{
              backgroundColor: 'var(--panel-bg)',
              borderRadius: '12px',
              border: '1px solid var(--border-color)',
              boxShadow: '0 20px 25px -5px rgba(0, 0, 0, 0.1), 0 10px 10px -5px rgba(0, 0, 0, 0.04)',
              width: '90%',
              maxWidth: '450px',
              padding: '24px',
              display: 'flex',
              flexDirection: 'column',
              gap: '16px'
            }}
            onKeyDown={handleKeyDown}
          >
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: '14px' }}>
              <div style={{
                fontSize: '1.8rem',
                lineHeight: 1,
                padding: '8px',
                borderRadius: '8px',
                backgroundColor: dialog.type === 'error' ? 'rgba(239, 68, 68, 0.1)' : dialog.type === 'confirm' ? 'rgba(245, 158, 11, 0.1)' : 'rgba(37, 99, 235, 0.1)'
              }}>
                {dialog.type === 'alert' && 'ℹ️'}
                {dialog.type === 'confirm' && '❓'}
                {dialog.type === 'prompt' && '📝'}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <h3 id="app-dialog-title" style={{
                  fontSize: '1.1rem',
                  fontWeight: '600',
                  color: 'var(--text-main)',
                  marginBottom: '8px'
                }}>
                  {dialog.type === 'alert' && 'Notification'}
                  {dialog.type === 'confirm' && 'Confirmation Required'}
                  {dialog.type === 'prompt' && 'Input Required'}
                </h3>
                <p style={{
                  fontSize: '0.95rem',
                  color: 'var(--text-muted)',
                  lineHeight: '1.5',
                  wordBreak: 'break-word',
                  whiteSpace: 'pre-wrap'
                }}>
                  {dialog.message}
                </p>
              </div>
            </div>

            {dialog.type === 'prompt' && (
              <input
                ref={promptInputRef}
                type="text"
                value={dialog.value}
                onChange={(e) => setDialog((prev) => ({ ...prev, value: e.target.value }))}
                style={{
                  width: '100%',
                  padding: '10px 12px',
                  borderRadius: '6px',
                  border: '1px solid var(--border-color)',
                  fontSize: '0.95rem',
                  outline: 'none',
                  backgroundColor: 'var(--bg-color)',
                  color: 'var(--text-main)'
                }}
              />
            )}

            <div style={{
              display: 'flex',
              justifyContent: 'flex-end',
              gap: '10px',
              marginTop: '8px'
            }}>
              {(dialog.type === 'confirm' || dialog.type === 'prompt') && (
                <button
                  className="btn-outline"
                  onClick={() => handleDialogAction(false)}
                  style={{ padding: '8px 16px' }}
                >
                  Cancel
                </button>
              )}
              <button
                className={dialog.type === 'confirm' && dialog.message.includes('WIPE') ? 'btn-danger' : 'btn-primary'}
                onClick={() => handleDialogAction(true)}
                style={{ padding: '8px 20px' }}
              >
                {dialog.type === 'confirm' ? 'Confirm' : 'OK'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Slide-in style for toasts */}
      <style>{`
        @keyframes slideIn {
          from {
            opacity: 0;
            transform: translateX(100px);
          }
          to {
            opacity: 1;
            transform: translateX(0);
          }
        }
      `}</style>
    </>
  );
};

export default CustomPopupContainer;
