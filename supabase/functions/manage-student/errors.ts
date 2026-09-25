import type { Logger } from './log.ts';
import type { DbError } from './types.ts';

export const statusErrorCode = (status: number) => (
  status === 400 ? 'VALIDATION_FAILED'
    : status === 401 ? 'AUTH_REQUIRED'
      : status === 403 ? 'FORBIDDEN'
        : status === 404 ? 'NOT_FOUND'
          : status === 409 ? 'CONFLICT'
            : status === 413 ? 'VALIDATION_FAILED'
              : status === 429 ? 'RATE_LIMITED'
                : 'UNAVAILABLE'
);

// Only errors raised deliberately by our SQL (RAISE EXCEPTION -> P0001, or the
// explicit permission errors -> 42501) carry messages meant for users. Anything
// else (constraint names, internal SQL text) is logged, not returned.
export const createSafeDbMessage = (log: Logger) => (error: DbError | null | undefined, fallback: string): string => {
  if (error && (error.code === 'P0001' || error.code === '42501') && typeof error.message === 'string') {
    return error.message;
  }
  if (error) {
    log.error('database_error', { code: error.code ?? null, message: error.message ?? null });
  }
  return fallback;
};
