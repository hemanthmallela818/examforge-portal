const recentReports = new Map();
const REPORT_WINDOW_MS = 60_000;

export const createIncidentId = () => {
  try {
    return crypto.randomUUID();
  } catch {
    return `incident-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }
};

// Bound the amount of text any single redaction pass must scan. Capping the
// input up front (rather than only slicing the output) keeps the regex work
// linear on hostile/oversized error strings and avoids a pathological stall.
const MAX_DIAGNOSTIC_INPUT = 4000;

export const redactDiagnosticText = value => String(value ?? '')
  .slice(0, MAX_DIAGNOSTIC_INPUT)
  .replace(/\b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\b/g, '[REDACTED_TOKEN]')
  .replace(/\bbearer\s+[A-Za-z0-9._~+/=-]+/gi, 'bearer [REDACTED]')
  .replace(/([?&](?:access_token|refresh_token|token|apikey|password)=)[^&#\s]+/gi, '$1[REDACTED]')
  .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[REDACTED_EMAIL]')
  .replace(/\b(password|secret|authorization|api[-_]?key)\s*[:=]\s*[^\s,;]+/gi, '$1=[REDACTED]')
  .slice(0, 1000);

export const safeErrorDetails = (error, context = 'runtime') => ({
  context: redactDiagnosticText(context),
  name: redactDiagnosticText(error?.name || 'Error'),
  message: redactDiagnosticText(error?.message || error || 'Unknown client error'),
  code: redactDiagnosticText(error?.code || ''),
  status: Number.isFinite(Number(error?.status)) ? Number(error.status) : undefined
});

export const reportClientError = (error, context = 'runtime') => {
  const details = safeErrorDetails(error, context);
  const fingerprint = `${details.context}|${details.name}|${details.message}|${details.code}`;
  const now = Date.now();
  if ((recentReports.get(fingerprint) || 0) > now - REPORT_WINDOW_MS) return null;
  recentReports.set(fingerprint, now);
  const incidentId = createIncidentId();
  console.error('[CLIENT_INCIDENT]', { incidentId, ...details });
  return incidentId;
};

export const installGlobalErrorHandlers = () => {
  const handleError = event => reportClientError(event.error || event.message, 'window.error');
  const handleRejection = event => reportClientError(event.reason, 'window.unhandledrejection');
  window.addEventListener('error', handleError);
  window.addEventListener('unhandledrejection', handleRejection);
  return () => {
    window.removeEventListener('error', handleError);
    window.removeEventListener('unhandledrejection', handleRejection);
  };
};
