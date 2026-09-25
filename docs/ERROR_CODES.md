# Error codes

Clients must branch on **codes**, never on message wording. `src/appErrors.js`
(`classifyAppError`) is the single place that maps server errors to the stable
application codes below. It checks, in order: an explicit application `code`
(Edge Function), the PostgreSQL SQLSTATE returned by PostgREST, the HTTP status,
and only then legacy message wording (so older servers keep working).

## Database (SQLSTATE, returned by PostgREST as `code`)

| SQLSTATE | Application code | Raised by | Message (unchanged) |
|---|---|---|---|
| `EX001` | `SESSION_REPLACED` | `assert_current_student_session` | This student session has been replaced or is no longer active |
| `EX002` | `PROFILE_MISSING` | `claim_student_session` | Student profile not found |
| `EX003` | `ACCOUNT_INACTIVE` | `claim_student_session` | This student account is inactive |
| `EX004` | `AUTH_REQUIRED` | `claim_student_session` | A valid authenticated Supabase session is required |
| `EX005` | `ALREADY_SUBMITTED` | `start_exam_session_internal` | This exam has already been submitted |
| `EX006` | `NOT_ASSIGNED` | start / submit internals | This exam is not assigned to you |
| `EX007` | `EXAM_UNAVAILABLE` | start / submit internals | This exam is not available (for submission) / This exam session is not available |
| `EX008` | `TIME_EXPIRED` | `sync_active_session_progress_internal` | Exam time has expired; progress was not saved |
| `EX009` | `SESSION_NOT_STARTED` | `submit_exam_internal` | Exam session was not started correctly |
| `EX010` | `ANSWER_KEY_MISSING` | `submit_exam_internal` | Answer key not found |
| `EX011` | `SESSION_NOT_FOUND` | `sync_active_session_progress_internal` | Active session not found or already submitted |
| `EX012` | `VALIDATION_FAILED` | exam internals | Response payload exceeds 256 KiB / Exam question data is invalid / A positive expected session version is required |
| `42501` | `FORBIDDEN` | root/admin guards (e.g. `admin_clear_question_bank`) | Root developer access is required |

`EX002` is also raised as "Active student profile not found" by the exam
internals, and `EX004` as "Authentication is required". Remaining `RAISE
EXCEPTION` sites (mostly administrator validation) use the default `P0001`;
the client still recognises the legacy wording as a fallback.
When touching a function, add `USING ERRCODE = 'EXnnn'` with a new row here.

## Edge Function (`manage-student`, JSON `code` field)

Every error response is `{ error, code, correlationId }` with an
`X-Correlation-Id` header. Explicit codes win; otherwise the code follows the
HTTP status:

| Status | Code |
|---|---|
| 400, 413 | `VALIDATION_FAILED` |
| 401 | `AUTH_REQUIRED` |
| 403 | `FORBIDDEN` |
| 404 | `NOT_FOUND` |
| 409 | `CONFLICT` |
| 429 | `RATE_LIMITED` |
| 5xx | `UNAVAILABLE` |

Only messages raised deliberately by our SQL (`P0001`, `42501`) are returned to
users; unexpected database errors are logged with the correlation ID and replaced
by a generic message (`safeDbMessage`).
