import { useDialogFocusTrap } from '../dialogFocus';

const AccessibleModal = ({ labelledBy, onEscape, returnFocusRef, maxWidth = '500px', children }) => {
  const { dialogRef, handleDialogKeyDown } = useDialogFocusTrap({ onEscape, returnFocusRef });

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby={labelledBy}
      tabIndex={-1}
      onKeyDown={handleDialogKeyDown}
      className="exam-modal-backdrop"
      style={{
        position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.85)', zIndex: 9999,
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '20px'
      }}
    >
      <div className="animate-fade-in exam-modal-content" style={{
        backgroundColor: 'white', padding: '40px', borderRadius: '12px', textAlign: 'center',
        width: '100%', maxWidth, maxHeight: 'calc(100dvh - 40px)', overflowY: 'auto'
      }}>
        {children}
      </div>
    </div>
  );
};

export default AccessibleModal;
