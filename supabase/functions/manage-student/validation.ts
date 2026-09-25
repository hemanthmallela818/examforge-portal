// Pure request validators: no I/O and no Deno APIs. Each returns either the
// typed input or the exact 400 message the function has always returned.

import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from './constants.ts';
import type { RequestBody, Validation } from './types.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const STUDENT_ID = /^[A-Za-z0-9._-]{2,64}$/;

const ok = <T>(value: T): Validation<T> => ({ ok: true, value });
const fail = <T>(error: string): Validation<T> => ({ ok: false, error });

/** Reads one body field; non-object bodies have no fields. */
export function field(body: RequestBody, key: string): unknown {
  return body !== null && typeof body === 'object' ? (body as Record<string, unknown>)[key] : undefined;
}

/** Coerces a field exactly as the function always has: String(value || ''). */
export function text(body: RequestBody, key: string): string {
  return String(field(body, key) || '');
}

export const actionName = (body: RequestBody): string => text(body, 'action');

const validPassword = (password: string) => (
  password.length >= MIN_PASSWORD_LENGTH && password.length <= MAX_PASSWORD_LENGTH
);

// ---- Root-only actions

export const SCOPED_CLEANUP_CONFIRMATIONS: Readonly<Record<string, string>> = {
  student_results: 'CLEAR EXAM RESULTS',
  cbt_exams: 'CLEAR EXAMS',
  question_bank: 'CLEAR QUESTION BANK',
};

export interface ScopedCleanupInput { target: string; confirmation: string }

export function validateScopedCleanup(body: RequestBody): Validation<ScopedCleanupInput> {
  const target = text(body, 'target');
  const expectedConfirmation = Object.hasOwn(SCOPED_CLEANUP_CONFIRMATIONS, target)
    ? SCOPED_CLEANUP_CONFIRMATIONS[target]
    : undefined;
  if (!expectedConfirmation || text(body, 'confirmation') !== expectedConfirmation) {
    return fail('Exact scoped cleanup confirmation is required');
  }
  return ok({ target, confirmation: expectedConfirmation });
}

export const RESET_APPLICATION_CONFIRMATION = 'RESET APPLICATION DATA';

export function validateResetApplication(body: RequestBody): Validation<{ confirmation: string }> {
  const confirmation = text(body, 'confirmation');
  if (confirmation !== RESET_APPLICATION_CONFIRMATION) {
    return fail('Exact reset confirmation is required');
  }
  return ok({ confirmation });
}

export const validateNothing = (_body: RequestBody): Validation<null> => ok(null);

export interface CreateAdminInput { email: string; name: string; password: string }

export function validateCreateAdmin(body: RequestBody): Validation<CreateAdminInput> {
  const email = text(body, 'email').trim().toLowerCase();
  const name = text(body, 'name').trim();
  const password = text(body, 'password');
  if (!EMAIL.test(email) || email.length > 254
    || !name || name.length > 120 || !validPassword(password)) {
    // Historic wording: the minimum is MIN_PASSWORD_LENGTH (12), not 10.
    return fail('Enter a valid email, name, and password of 12 to 128 characters');
  }
  return ok({ email, name, password });
}

// ---- Administrator actions

export interface ResetStudentPasswordInput { studentUserId: string; password: string }

export function validateResetStudentPassword(body: RequestBody): Validation<ResetStudentPasswordInput> {
  const studentUserId = text(body, 'studentUserId').trim();
  const password = text(body, 'password');
  if (!UUID.test(studentUserId)) return fail('A valid student user ID is required');
  if (!validPassword(password)) return fail('Password must be between 12 and 128 characters');
  return ok({ studentUserId, password });
}

/**
 * Class assignment is validated first; the action-specific `details` are only
 * reported after the class and section have been confirmed in the database,
 * which preserves the order in which errors have always been returned.
 */
export interface AssignedInput<Details> {
  className: string;
  section: string;
  details: Validation<Details>;
}

function validateAssigned<Details>(body: RequestBody, details: Validation<Details>): Validation<AssignedInput<Details>> {
  const className = text(body, 'className').trim();
  const section = text(body, 'section').trim();
  if (!className || className.length > 120 || !section || section.length > 60) {
    return fail('Class and section are required');
  }
  return ok({ className, section, details });
}

export function validateUpdateAssignment(body: RequestBody): Validation<AssignedInput<{ studentUserId: string }>> {
  const studentUserId = text(body, 'studentUserId').trim();
  return validateAssigned(body, UUID.test(studentUserId)
    ? ok({ studentUserId })
    : fail('A valid student user ID is required'));
}

export interface NewStudentDetails { studentId: string; name: string; password: string }

function validateNewStudentDetails(body: RequestBody): Validation<NewStudentDetails> {
  const studentId = text(body, 'studentId').trim();
  const name = text(body, 'name').trim();
  const password = text(body, 'password');
  if (!STUDENT_ID.test(studentId)) {
    return fail('Student ID must be 2 to 64 letters, numbers, dots, underscores, or hyphens');
  }
  if (!name || name.length > 120) return fail('Student name must be between 1 and 120 characters');
  if (!validPassword(password)) return fail('Password must be between 12 and 128 characters');
  return ok({ studentId, name, password });
}

export function validateCreateStudent(body: RequestBody): Validation<AssignedInput<NewStudentDetails>> {
  return validateAssigned(body, validateNewStudentDetails(body));
}
