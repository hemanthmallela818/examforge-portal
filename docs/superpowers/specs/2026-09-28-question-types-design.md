# More question types: design

Date: 2026-09-28
Branch: `feat/question-types` (delivered as one pull request)

## Goal

Cover the JEE Advanced and NEET question formats:

- multiple correct answers, with partial marking
- integer type
- matrix match
- paragraph-based question sets
- assertion–reason

The server stays authoritative. Grading, answer validation, and answer-key hiding remain in PostgreSQL. The browser is still never trusted with answers.

## Decisions already made

| Topic | Decision |
|---|---|
| Matrix match format | List-I / List-II table with 4 options and one correct option (current JEE Advanced and NEET format). |
| Multiple-correct marking | JEE Advanced rule, with a per-exam switch that turns partial marks off. |
| Scorecard | A separate "Partially correct" count (new results column). |
| Delivery | One pull request. |

## 1. Question types

| Code | Label | Options | Correct answer (`correct_answer`, text) | Candidate answer (`selectedOption`) | Graded as |
|---|---|---|---|---|---|
| `MCQ` (existing) | Single correct | exactly 4 | `^[0-3]$` | option index | index equality |
| `MULTIPLE_CORRECT` | Multiple correct | exactly 4 | sorted, comma-separated, distinct indices: `^[0-3](,[0-3]){0,3}$`, strictly increasing, e.g. `"0,2"` | same canonical string | section 2 rule |
| `INTEGER` | Integer type | none | `^[+-]?[0-9]+$`, at most 100 characters | same grammar, at most 64 characters | numeric equality |
| `NUMERICAL` / `NAT` (existing) | Numerical value | none | decimal grammar (unchanged) | decimal grammar (unchanged) | absolute tolerance 0.00001 (unchanged) |
| `MATRIX_MATCH` | Matrix match | exactly 4 (each one a full mapping, written by the author) | `^[0-3]$` | option index | index equality |
| `ASSERTION_REASON` | Assertion–Reason | exactly 4 | `^[0-3]$` | option index | index equality |

Rules:

- **Option-bearing types** (`MCQ`, `MULTIPLE_CORRECT`, `MATRIX_MATCH`, `ASSERTION_REASON`) keep every existing MCQ option rule:
  - exactly 4 options
  - each option has text or an image
  - each option is at most 5000 characters
  - options must be unique
- **Value types** (`INTEGER`, `NUMERICAL`, `NAT`) have `options = []`.
- **Candidate answers stay strings or numbers.** A multiple-correct answer is the canonical string (`"0,2"`), never an array. Autosave, offline recovery, the pending-submission queue, and the submit payload shape do not change.
- **Unanswered:** a multiple-correct question with nothing ticked is stored as `selectedOption: null`, exactly like an unanswered MCQ.
- **`NAT`** stays accepted wherever it is today. It is graded and marked exactly like `NUMERICAL`.
- **Paragraph sets are not a type.** Any question of any type can belong to a passage (see section 3).
- **Assertion–Reason is an editor template.** Choosing it fills the question text with `Assertion (A): …` and `Reason (R): …` and fills the 4 standard options:
  1. Both (A) and (R) are true and (R) is the correct explanation of (A).
  2. Both (A) and (R) are true but (R) is not the correct explanation of (A).
  3. (A) is true but (R) is false.
  4. (A) is false but (R) is true.

  The author can still edit the text and options. It needs no extra storage.

## 2. Marking

### Per-type marking

`questions_data` gets an optional `marking` object:

```json
{
  "marksCorrect": 4,
  "marksIncorrect": -1,
  "marking": {
    "MCQ":              { "correct": 3, "incorrect": -1 },
    "MULTIPLE_CORRECT": { "correct": 4, "incorrect": -2, "partial": true },
    "INTEGER":          { "correct": 4, "incorrect": 0 },
    "MATRIX_MATCH":     { "correct": 3, "incorrect": -1 }
  }
}
```

- **Keys** are the type codes `MCQ`, `MULTIPLE_CORRECT`, `INTEGER`, `NUMERICAL`, `MATRIX_MATCH`, and `ASSERTION_REASON`. `NAT` questions use the `NUMERICAL` entry.
- **Every field is optional:**
  - a missing `correct` falls back to `marksCorrect`
  - a missing `incorrect` falls back to `marksIncorrect`
  - a missing `partial` means `true`
- **Unchanged behaviour:** exams without `marking` grade exactly as today. NEET-style "+4 / −1 for everything" needs no setup.
- **Bounds** are the same as today's exam-wide values:
  - `correct` is in (0, 100]
  - `incorrect` is in [−100, 0]
  - both have at most 2 decimal places
  - `partial` is a boolean and is allowed only on `MULTIPLE_CORRECT`
  - unknown keys are rejected

### Multiple-correct rule

Let *C* be the set of correct options and *S* the set of options the candidate ticked. *full* and *neg* are that type's resolved `correct` and `incorrect` marks.

| Case | Outcome | Marks |
|---|---|---|
| *S* is empty | unattempted | 0 |
| *S* = *C* | correct | *full* |
| *S* contains a wrong option | incorrect | *neg* |
| *S* ⊂ *C*, partial on | partial | *full* × \|*S*\| / 4, rounded to 2 decimal places |
| *S* ⊂ *C*, partial off | incorrect | *neg* |

With *full* = 4 this is exactly the JEE Advanced rule:

- +3 when all four options are correct and three are ticked
- +2 when two correct options are ticked
- +1 when one correct option is ticked
- −2 in all other cases

The partial mark is always below *full*, because a proper subset has at most 3 options.

### Totals

- `maxScore` is the sum over all questions of each question's resolved *full* marks.
- The counters are `correct`, `partial`, `incorrect`, and `unattempted`. They add up to the total number of questions.

## 3. Storage

### `question_bank.details` (new nullable `jsonb` column)

```json
{
  "matchLists": { "left": ["…", "…"], "right": ["…", "…"] },
  "passage":    { "key": "<uuid>", "text": "…" }
}
```

- **`matchLists`:**
  - Required for `MATRIX_MATCH` and forbidden for every other type.
  - `left` has 2–6 items and `right` has 2–8 items.
  - Each item is a non-empty string of at most 2000 characters.
  - Items are displayed labelled P, Q, R, S, T, U (List-I) and 1–8 (List-II).
- **`passage`:**
  - Optional on any type.
  - `key` is a UUID generated by the client.
  - `text` is 1–10000 characters.
  - Every question with the same `key` is one paragraph set.
- **Limits:** no other keys, and the whole object is at most 32 KiB.
- **Images:** match lists and passages are text plus LaTeX only (see "Out of scope").

### Validation

One SQL helper, `assert_valid_question_details(type, details)`, holds these rules. It is called by:

- the `validate_question_bank_content` trigger
- `admin_import_questions`
- the exam-paper validators

### Duplicate detection

The unique index `question_bank_canonical_text_unique` is recreated on:

```
md5(canonical_question_text(question_text) || '|' || COALESCE(details::text, ''))
```

Without this, every "Match List-I with List-II…" stem, and every short follow-up question in a paragraph set, would collide with the first one. Rows without `details` keep their current duplicate behaviour.

Three places use the same key:

- the index
- the import RPC's duplicate check
- the client duplicate checks (`questionContentLogic`, `importLogic`)

### CHECK constraint

`question_bank_data_valid` is re-created for the new types. It is added `NOT VALID` and then validated, the pattern used in `20260917090000`.

### Editing a passage

- **Where the passage is edited:** the passage text is edited in one place, the bank's **Edit passage** action. It calls a new RPC, `admin_update_passage(passage_key uuid, passage_text text)`, which updates every question in the set in one statement.
- **Security:** the RPC is `SECURITY INVOKER`, so the existing admin RLS policy applies. It also has an explicit AAL2 admin check. Execute is granted to `authenticated` only.
- **In the question editor:** the passage is shown read-only, except when a new paragraph set is created.
- **Existing exams keep their snapshot,** exactly as they do for question edits today.

## 4. Exam paper and shuffle

- **Paper questions carry `details`.**
  - The builder copies it from the bank.
  - Both paper validators accept the new types and check `details` and `marking`:
    - `validate_full_exam_paper_internal`, through its `validate_full_exam_paper` wrapper
    - `validate_cbt_exams_raw_record`
  - `details` holds no answer information, so answer-key stripping is unchanged: only `correctAnswer` is removed.
- **The builder keeps each passage's questions together within a subject,** in bank order.
- **`start_exam_session_internal` shuffles in blocks.**
  - Each passage is one block, and each other question is a block of its own.
  - Blocks are shuffled.
  - Questions inside a block keep their paper order.
  - The client fallback shuffle (`examSessionHelpers.shuffleArray`) gets the same grouping.
- **The student-visible exam metadata** (`questions_data` without `questions`) now includes `marking`, so the pre-exam screen can show the rules for each type.

## 5. Server grading and answer validation

New shared SQL helpers, `SET search_path = ''`, following the repo's hardening conventions:

| Helper | Purpose | Used by |
|---|---|---|
| `assert_valid_response_value(type, options_count, value jsonb)` | candidate answer grammar and range per type | `sanitize_exam_responses` (autosave), `normalize_submission_response_map` (submit) |
| `resolve_question_marking(paper jsonb, type)` | returns `{correct, incorrect, partial}` with fallbacks | `submit_exam_internal`, result review |
| `score_question_response(type, correct_answer, response jsonb, marking jsonb)` | returns `{outcome, marks}` | `submit_exam_internal`, result review |
| `normalize_exam_marking(jsonb)` | validates or normalizes `marking` | paper validators, `admin_save_exam_template` |

Redefined, in one new forward-only migration:

- **Question bank:**
  - the `validate_question_bank_content` trigger and the `question_bank_data_valid` CHECK
  - `admin_import_questions`: new types, a `details` field, and the new duplicate key
  - `get_admin_question_bank_page`: filters by the real type instead of bucketing unknown types as MCQ, and returns `details`
  - `get_admin_questions_by_ids`: returns `details`
- **Exam paper:** `validate_full_exam_paper_internal`, `validate_cbt_exams_raw_record`, and `start_exam_session_internal`.
- **Answer validation:** `sanitize_exam_responses` and `normalize_submission_response_map`, which delegate to the shared helper.
- **Grading and results:**
  - `submit_exam_internal`: shared scorer, per-type marks, `partial` counter, and new `maxScore`
  - `get_student_exam_result`: returns `partial`
  - `get_admin_student_result_review` (see section 6)
- **Patterns:** `admin_save_exam_template` gets a new `marking_param jsonb` argument, so the old signature is dropped. `admin_list_exam_templates` returns `marking`.

Other schema changes:

- New `student_results.partial integer NOT NULL DEFAULT 0 CHECK (partial >= 0)`. Existing rows read 0. No row is rewritten and no trigger fires.
- New `exam_templates.marking jsonb NULL`.

`submit_exam` now returns:

```json
{ "totalScore", "maxScore", "correct", "partial", "incorrect", "unattempted", "subjectScores" }
```

Invalid answers raise the same errors as today's invalid MCQ and numerical answers. No new error codes are added.

## 6. Result review: fix for an existing bug

**The bug:**

- `capture_student_result_review` saves the candidate's responses by their position in the shuffled paper.
- `get_admin_student_result_review` returns the unshuffled paper.
- The admin review modal pairs them by position, so it shows the wrong answer against most questions.

**The fix: store exactly what was graded, at grading time.**

- **`student_result_reviews` gets two new columns:**
  - `snapshot_format text NOT NULL DEFAULT 'legacy_position'`, with a CHECK that allows `legacy_position` and `by_question_id`
  - `question_scores jsonb NULL`
- **`submit_exam_internal` writes the review row** right after inserting the result:
  - `response_snapshot` is the graded `response_map`, which is keyed by question ID
  - `question_scores` is `{qid: {outcome, marks}}`, collected in the grading loop
  - `snapshot_format` is `'by_question_id'`
  - The write is an upsert on `result_id`, so it overwrites the positional row the existing capture trigger inserts. The trigger itself is unchanged.
- **Review RPC:** it additionally returns `snapshot_format` and `question_scores`. The modal:
  - pairs answers by question ID
  - shows the stored outcome and marks, including partial marks
  - needs no JavaScript copy of the grading rules
  - always matches the score the student received, even for a submission graded from a client payload
- **Older attempts:** their snapshots are positional and the shuffle order was never saved.
  - Their rows keep `snapshot_format = 'legacy_position'`.
  - The modal shows "Per-question review is unavailable for attempts submitted before this update: their question order was not recorded". It still shows subject times.
  - It no longer shows misaligned answers.

## 7. Exam patterns

- The pattern editor gets a **Marking by question type** table.
  - It has a row for each type, with Correct, Wrong, and (for multiple correct) Partial marks.
  - A blank value means "use the pattern default".
- The values are saved to `exam_templates.marking`.
- An exam created from a pattern copies the pattern's `marking`, locked like today's two values.

## 8. Admin interface

- **`src/questionTypes.js` (new, pure):**
  - the type registry: codes, labels, option-bearing or value type, badge text
  - author and candidate answer validation
  - multiple-correct encode and decode
  - answer display text
  - the marking resolver used for mark totals in the wizard

  It replaces the roughly 25 hard-coded `MCQ`/`NUMERICAL` checks in the editor, importer, preflight, bank, wizard, archive, review modal, and exam screen.
- **Question editor:**
  - the type selector lists all six types
  - multiple correct: four "Correct" checkboxes
  - integer: a whole-number field
  - matrix match: List-I and List-II row editors with add and remove, plus the 4 options and a single answer
  - assertion–reason: applies the template (it asks before overwriting text that is already filled in)
  - passage: shown read-only, or editable when creating a new set
- **Question bank:**
  - a create menu with all types plus **New paragraph set**
  - a type filter with all types
  - per-type answer display
  - passage questions show a passage excerpt with **Add question to this passage** and **Edit passage**
- **Exam wizard and Create Exam card:**
  - a type filter and badges
  - a **Marking by question type** table for the types in the selection (blank means the exam default)
  - mark totals use per-type marks
  - review checks
  - the paper preview comes for free through `QuestionPanel`
- **Question archive and answer review modal:** per-type display, with the modal using server scores (section 6).
- **JSON import and AI importer:** see section 10.

## 9. Student interface

- **`QuestionPanel`:** the badge and input depend on the type.

  | Type | Input |
  |---|---|
  | Multiple correct | a checkbox group with "One or more options may be correct." |
  | Integer | the existing keypad without the decimal key, `inputMode="numeric"` |
  | Matrix match | a two-column List-I / List-II table above the option radios |
  | Assertion–reason | rendered like a single-correct question (the text holds A and R) |

  The strings that `tests/stage16-numerical-answer-policy.test.mjs` asserts stay unchanged.
- **Paragraph sets:** a passage block (MathRenderer, pre-wrap, scrollable) appears above the question text of every question in the set.
- **Pre-exam screen:** lists the marks for each type from `marking`, and the exam-wide rule for the others.
- **Scorecard and dashboard:** show "Partially correct" when `partial > 0`.

## 10. Import format (JSON, still version `1.0`, additive)

- **`question_type`:** adds `MULTIPLE_CORRECT`, `INTEGER`, `MATRIX_MATCH`, and `ASSERTION_REASON`.
- **`correct_answer` for `MULTIPLE_CORRECT`:** `"A,C"`, `["A","C"]`, or `"0,2"`, all normalized to `"0,2"`.
- **`match_lists`:** `{ "list_i": [...], "list_ii": [...] }`, required for `MATRIX_MATCH` only.
- **`passage`:** `{ "key": "<any file-local label>", "text": "..." }`.
  - Rows sharing a key form one set and must have identical text.
  - A mismatch is reported as the new row error `ROW_PASSAGE_MISMATCH`.
  - Each file-local key becomes a fresh UUID for the import batch, so an import always creates new sets.
- **New row errors:** `ROW_INVALID_MULTI_ANSWER`, `ROW_INVALID_INTEGER_ANSWER`, `ROW_INVALID_MATCH_LISTS`, and `ROW_PASSAGE_MISMATCH`.
- **The atomic import payload** gains `details`.
- **The AI importer prompt** and the per-row editors cover the new types.
- **`docs/REVIEWED_JSON_IMPORT.md`** is updated.

## 11. Compatibility and rollout

- Existing questions, exams, and results are untouched. `MCQ`, `NUMERICAL`, and `NAT` grade exactly as before, and exams without `marking` use the exam-wide marks.
- Deployment order:
  1. Apply the migration.
  2. Deploy the web app.
  3. Only then create questions or exams with the new types.

  Old cached app bundles do not understand the new types, but no exam can contain them until someone authors one.
- Sessions in progress during the deployment grade identically, because their papers have no `marking` and only old types.

## 12. Testing

- **Database** (PGlite, `tests/db/question-types.test.mjs`, new):
  - grading for every type
  - every multiple-correct case in section 2, with partial on and off
  - per-type marks and their fallbacks
  - `maxScore` and the four counters
  - rejected candidate answers: `"2,0"`, `"0,0"`, `"4"`, `"2.5"` for an integer question, an array value
  - bank CHECK and trigger rules for `details`
  - the duplicate key
  - the block shuffle keeps a passage together and in order
  - the review snapshot is keyed by ID and returns scores
  - legacy review alignment
  - the pattern `marking` round trip
  - `admin_update_passage` (admin succeeds, a student is refused)
- **Unit** (`node:test`):
  - `questionTypes.js`
  - `questionContentLogic` and `importLogic` for the new types
  - preflight
  - pattern and marking validation
- **Components** (Vitest):
  - `QuestionPanel`: checkbox group, integer keypad, match table, passage block
  - `QuestionEditor`: new type editors and the assertion–reason template
  - the wizard marking table
- **End to end:** the student journey fixture gains a multiple-correct question, with the expected score updated.
- **Existing tests updated where the contract intentionally changes:**
  - the `submit_exam` result shape (`partial`)
  - the `admin_save_exam_template` signature in `migrations-replay.test.mjs`
  - `SubjectsAndPatternsView` RPC arguments
- **Also run:** `npm run schema:reference`, and `docs/STAGE21_AUTHORIZATION_MANIFEST.md` gains `admin_update_passage`.
- **Local gates before the pull request:**
  - `lint`
  - `typecheck`
  - `schema:reference:check`
  - `test:components`
  - `test:db`
  - `test:coverage`
  - `build`
  - End-to-end tests need Docker. They run in CI, and locally if Docker is available.

## Out of scope (add when needed)

- **Images inside passages or match lists.** The asset reference and cleanup functions would first need to learn the new image paths, otherwise cleanup could delete an image that is still in use.
- **The pre-2019 grid-style matrix match,** where each row is marked separately.
- **A per-question review for students.**
- **Importing extra questions into an existing paragraph set.** An import always creates new sets.
- **Shuffling options within a question.**
