// Custom popup and toast event dispatchers
export const showToast = (message, type = 'info') => {
  const event = new CustomEvent('app-toast', { detail: { message, type } });
  window.dispatchEvent(event);
};

// Dispatch a dialog request and return a promise that resolves when the mounted
// dialog host (CustomPopupContainer) responds. The event is cancelable: the host
// calls preventDefault() to acknowledge it will resolve the promise. If no host
// consumes the event (e.g. dispatched before the container mounts or after
// teardown), dispatchEvent returns true and we resolve a safe, non-destructive
// default so the caller never hangs awaiting a dialog that will never appear.
const requestDialog = (detail, fallback) => new Promise((resolve) => {
  const event = new CustomEvent('show-dialog', {
    detail: { ...detail, onResolve: resolve },
    cancelable: true
  });
  const consumed = window.dispatchEvent(event) === false;
  if (!consumed) resolve(fallback);
});

export const customAlert = (message) => requestDialog({ type: 'alert', message }, undefined);

export const customConfirm = (message) => requestDialog({ type: 'confirm', message }, false);

export const customPrompt = (message, defaultValue = '') =>
  requestDialog({ type: 'prompt', message, defaultValue }, null);
