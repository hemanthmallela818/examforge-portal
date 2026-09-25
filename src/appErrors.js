/**
 * #6: one place that turns server errors into stable application error codes.
 *
 * Order of evidence: an explicit application code (Edge Function JSON `code`),
 * then the PostgreSQL SQLSTATE returned by PostgREST (`EX…` codes raised by our
 * SQL, see supabase/migrations/20260925110000_stable_session_error_codes.sql),
 * then HTTP status, and only as a last resort the legacy message wording, so
 * older servers keep working. See docs/ERROR_CODES.md.
 */

export const APP_ERROR = Object.freeze({
  SESSION_REPLACED: 'SESSION_REPLACED',
  PROFILE_MISSING: 'PROFILE_MISSING',
  ACCOUNT_INACTIVE: 'ACCOUNT_INACTIVE',
  AUTH_REQUIRED: 'AUTH_REQUIRED',
  ALREADY_SUBMITTED: 'ALREADY_SUBMITTED',
  SESSION_NOT_FOUND: 'SESSION_NOT_FOUND',
  NOT_ASSIGNED: 'NOT_ASSIGNED',
  EXAM_UNAVAILABLE: 'EXAM_UNAVAILABLE',
  TIME_EXPIRED: 'TIME_EXPIRED',
  SESSION_NOT_STARTED: 'SESSION_NOT_STARTED',
  ANSWER_KEY_MISSING: 'ANSWER_KEY_MISSING',
  FORBIDDEN: 'FORBIDDEN',
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  RATE_LIMITED: 'RATE_LIMITED',
  RESULT_SET_CHANGED: 'RESULT_SET_CHANGED',
  UNAVAILABLE: 'UNAVAILABLE',
  UNKNOWN: 'UNKNOWN'
});

/** @type {Readonly<Record<string, string>>} SQLSTATE → application code */
export const SQLSTATE_CODES = Object.freeze({
  EX001: APP_ERROR.SESSION_REPLACED,
  EX002: APP_ERROR.PROFILE_MISSING,
  EX003: APP_ERROR.ACCOUNT_INACTIVE,
  EX004: APP_ERROR.AUTH_REQUIRED,
  EX005: APP_ERROR.ALREADY_SUBMITTED,
  EX006: APP_ERROR.NOT_ASSIGNED,
  EX007: APP_ERROR.EXAM_UNAVAILABLE,
  EX008: APP_ERROR.TIME_EXPIRED,
  EX009: APP_ERROR.SESSION_NOT_STARTED,
  EX010: APP_ERROR.ANSWER_KEY_MISSING,
  EX011: APP_ERROR.SESSION_NOT_FOUND,
  EX012: APP_ERROR.VALIDATION_FAILED,
  42501: APP_ERROR.FORBIDDEN
});

/** @type {ReadonlyArray<[RegExp, string]>} legacy wording, checked last */
const LEGACY_MESSAGE_PATTERNS = Object.freeze([
  [/student session has been replaced|no longer active/i, APP_ERROR.SESSION_REPLACED],
  [/account is inactive/i, APP_ERROR.ACCOUNT_INACTIVE],
  [/already been submitted/i, APP_ERROR.ALREADY_SUBMITTED],
  [/active (?:exam )?session not found|already submitted/i, APP_ERROR.SESSION_NOT_FOUND],
  [/not assigned/i, APP_ERROR.NOT_ASSIGNED],
  [/not available/i, APP_ERROR.EXAM_UNAVAILABLE],
  [/time has expired|session has expired/i, APP_ERROR.TIME_EXPIRED],
  [/not started correctly/i, APP_ERROR.SESSION_NOT_STARTED],
  [/profile not found/i, APP_ERROR.PROFILE_MISSING],
  [/answer key not found/i, APP_ERROR.ANSWER_KEY_MISSING],
  [/result set changed/i, APP_ERROR.RESULT_SET_CHANGED],
  [/rate limit|too many requests/i, APP_ERROR.RATE_LIMITED]
]);

/** @type {Set<string>} */
const KNOWN_CODES = new Set(Object.values(APP_ERROR));

/**
 * @param {unknown} error Supabase/PostgREST error, Edge Function payload or Error.
 * @returns {string} One of APP_ERROR.
 */
export function classifyAppError(error) {
  if (!error || typeof error !== 'object') return APP_ERROR.UNKNOWN;
  const record = /** @type {Record<string, unknown>} */ (error);

  const appCode = typeof record.appCode === 'string' ? record.appCode : null;
  if (appCode && KNOWN_CODES.has(appCode)) return appCode;

  const code = typeof record.code === 'string' ? record.code : '';
  if (KNOWN_CODES.has(code)) return code;
  if (SQLSTATE_CODES[code]) return SQLSTATE_CODES[code];

  const message = typeof record.message === 'string' ? record.message
    : typeof record.error === 'string' ? record.error : '';
  for (const [pattern, mapped] of LEGACY_MESSAGE_PATTERNS) {
    if (pattern.test(message)) return mapped;
  }

  const status = Number(record.httpStatus ?? record.status);
  if (status === 429) return APP_ERROR.RATE_LIMITED;
  if (status === 409) return APP_ERROR.CONFLICT;
  if (status === 404) return APP_ERROR.NOT_FOUND;
  if (status === 403) return APP_ERROR.FORBIDDEN;
  if (status >= 500) return APP_ERROR.UNAVAILABLE;
  return APP_ERROR.UNKNOWN;
}

/**
 * @param {unknown} error
 * @param {string} code
 * @returns {boolean}
 */
export const isAppError = (error, code) => classifyAppError(error) === code;
