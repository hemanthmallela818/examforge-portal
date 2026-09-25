/** @import { FunctionInvocationResult, UntrustedInput } from './types' */

/**
 * @param {unknown} value
 * @returns {string}
 */
const cleanMessage = value => {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, 500);
};

const REFERENCE_PATTERN = /^[0-9a-f-]{8,64}$/i;

/**
 * @param {UntrustedInput} payload
 * @returns {string}
 */
const messageFromPayload = payload => {
  if (!payload || typeof payload !== 'object') return '';
  const message = cleanMessage(payload.error) || cleanMessage(payload.message);
  if (!message) return '';
  // Server errors carry a correlation ID so support can find the matching log entry.
  const reference = typeof payload.correlationId === 'string' && REFERENCE_PATTERN.test(payload.correlationId)
    ? payload.correlationId
    : '';
  return reference ? `${message} (Reference: ${reference})` : message;
};

/**
 * Structured variant: `{ message, code, reference }`, where `code` is a stable
 * application code (see src/appErrors.js) when the server provided one.
 * @param {FunctionInvocationResult | null | undefined} result
 * @param {string} fallback
 * @returns {Promise<{ message: string, code: string | null, reference: string | null }>}
 */
export const readFunctionInvocationErrorDetails = async (result, fallback) => {
  /** @type {Record<string, unknown> | null} */
  let payload = result?.data && typeof result.data === 'object' ? /** @type {Record<string, unknown>} */ (result.data) : null;
  const response = result?.error?.context;
  if (!payload && response && typeof response.clone === 'function') {
    try { payload = await response.clone().json(); } catch { payload = null; }
  }
  const code = payload && typeof payload.code === 'string' ? payload.code : null;
  const reference = payload && typeof payload.correlationId === 'string' && REFERENCE_PATTERN.test(payload.correlationId)
    ? payload.correlationId : null;
  return { message: await readFunctionInvocationError(result, fallback), code, reference };
};

/**
 * Best user-facing message from a failed `supabase.functions.invoke` call.
 * @param {FunctionInvocationResult | null | undefined} result
 * @param {string} fallback
 * @returns {Promise<string>}
 */
export const readFunctionInvocationError = async (result, fallback) => {
  const directMessage = messageFromPayload(result?.data);
  if (directMessage) return directMessage;

  const response = result?.error?.context;
  if (response && typeof response.clone === 'function') {
    try {
      const payload = await response.clone().json();
      const responseMessage = messageFromPayload(payload);
      if (responseMessage) return responseMessage;
    } catch {
      // The response may not be JSON. The SDK message remains a safe fallback.
    }
  }

  return cleanMessage(result?.error?.message) || fallback;
};
