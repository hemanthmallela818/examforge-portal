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

Each question uses `question_number`, `question_text`, `question_type`, `options`, `correct_answer`, `subject`, and `has_image_or_diagram`. An optional unique text `id` may be supplied for review diagnostics. Download the schema from the importer for the authoritative field limits and allowed values.

## Review rules

- MCQs require exactly four unique options labelled A–D and one answer A–D.
- Numerical questions require an empty options array and a signed decimal answer. Zero is valid.
- Subjects are Physics, Chemistry, or Mathematics.
- Duplicate IDs and duplicate normalized question text are rejected.
- Unbalanced `$...$` or `$$...$$` delimiters must be corrected.
- Imported JSON never contains image files or public image URLs. Media is uploaded separately to the private `exam-assets` bucket and verified during exam activation.
