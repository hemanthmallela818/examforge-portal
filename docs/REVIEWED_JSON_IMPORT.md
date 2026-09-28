# Reviewed JSON Import

The portal accepts reviewed JSON only. It does not read or extract questions from PDFs, images, word-processing documents, OCR output, or AI services.

## Safe workflow

1. Convert source material outside the portal using an approved process.
2. In **Admin → Reviewed JSON Import**, download the current JSON example and schema.
3. Validate the converted file against schema version `1.0`.
4. Upload one `.json` file of no more than 5 MB and 500 questions.
5. Review every prompt, option, correct answer, subject, equation, and diagram indicator.
6. Explicitly approve the rows to import. Rows with blocking diagnostics cannot be approved.
7. Commit once. If the response is lost, keep the page open and retry the same batch; the server returns the already committed outcome without duplicating questions.
8. For any row marked as containing an image or diagram, attach the verified private image in the Question Bank before assembling or activating an exam.

## Required document shape

The top-level object contains only:

- `version`: exactly `"1.0"`
- `questions`: an array containing 1–500 question objects

Each question uses these fields:

- `question_number`
- `question_text`
- `question_type`
- `options`
- `correct_answer`
- `subject`
- `has_image_or_diagram`

Optional fields:

- `id`: a unique text value used in review diagnostics.
- `match_lists`: for matrix match only.
- `passage`: for paragraph sets.

Download the schema from the importer for the authoritative field limits and allowed values.

## Question types

| `question_type` | Options | `correct_answer` |
|---|---|---|
| `MCQ` | exactly 4, labelled A–D | one letter, e.g. `"B"` |
| `MULTIPLE_CORRECT` | exactly 4, labelled A–D | every correct letter, e.g. `"A,C"` or `["A", "C"]` |
| `INTEGER` | empty array | a whole number, e.g. `"42"` or `"-7"` |
| `NUMERICAL` | empty array | a signed decimal, e.g. `"2.5"`; zero is valid |
| `MATRIX_MATCH` | exactly 4 complete matchings, e.g. `"P→2, Q→1, R→4, S→3"` | one letter |
| `ASSERTION_REASON` | exactly 4 (the standard Assertion–Reason options) | one letter |

**Matrix match** questions also need `match_lists`:

- `list_i` has 2–6 items, shown as P, Q, R, S, T, U.
- `list_ii` has 2–8 items, shown as 1–8.

```json
"match_lists": { "list_i": ["Force", "Power"], "list_ii": ["Newton", "Watt", "Joule"] }
```

**Assertion–Reason** questions put both statements in `question_text`, as `"Assertion (A): …\n\nReason (R): …"`.

**Paragraph sets** (comprehension) repeat the same `passage` on every question of the set:

- `key` is any label that is unique within the file, such as `"P1"`.
- `text` must be identical on every question in the set.
- Each import creates new paragraph sets; a key is never matched to an existing set.

```json
"passage": { "key": "P1", "text": "A ball is thrown vertically upwards with speed 20 m/s." }
```

## Review rules

- Option-based types need exactly four unique, non-empty options.
- Integer and numerical questions need an empty options array.
- Subjects must be one of the subjects configured under **Subjects & Patterns**.
- Duplicate IDs and duplicate questions are rejected. Two matrix-match questions can share the same stem when their lists differ. Questions in different paragraphs can share the same text.
- Unbalanced `$...$` or `$$...$$` delimiters must be corrected. This applies to question text, options, list items and paragraphs.
- Imported JSON never contains image files or public image URLs. Media is uploaded separately to the private `exam-assets` bucket and verified during exam activation.

## Row error codes

| Code | Meaning |
|---|---|
| `ROW_INVALID_TYPE` | `question_type` is not one of the six types above |
| `ROW_INVALID_ANSWER` | the single correct letter is not A–D |
| `ROW_INVALID_MULTI_ANSWER` | a multiple-correct answer does not list one or more of A–D |
| `ROW_INVALID_INTEGER_ANSWER` | an integer answer is not a whole number |
| `ROW_INVALID_NUMERICAL_ANSWER` | a numerical answer is not a decimal number |
| `ROW_NUMERICAL_NONEMPTY_OPTIONS` | an integer or numerical question has options |
| `ROW_INVALID_MATCH_LISTS` | a matrix-match question is missing its lists, or its lists are out of bounds |
| `ROW_INVALID_PASSAGE` | a paragraph has an empty key or text, or text over 10,000 characters |
| `ROW_PASSAGE_MISMATCH` | questions sharing a paragraph key use different paragraph text |
| `ROW_DUPLICATE_QUESTION_BANK`, `ROW_DUPLICATE_IN_FILE`, `ROW_DUPLICATE_SOURCE_ID` | duplicates |
