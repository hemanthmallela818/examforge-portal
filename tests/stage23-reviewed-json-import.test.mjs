import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  IMPORT_EXAMPLE_DOCUMENT,
  IMPORT_JSON_SCHEMA_DOCUMENT,
  MAX_IMPORT_QUESTIONS,
  parseImportDocument,
  parseImportJsonText,
  validateImportFile
} from '../src/importLogic.js';
import { validateImageUpload } from '../src/imageValidation.js';

const validMcq = (index = 1, overrides = {}) => ({
  id: `physics-${index}`,
  question_number: index,
  question_text: `Unique reviewed question ${index}?`,
  question_type: 'MCQ',
  options: [
    { label: 'A', text: `A${index}` },
    { label: 'B', text: `B${index}` },
    { label: 'C', text: `C${index}` },
    { label: 'D', text: `D${index}` }
  ],
  correct_answer: 'A',
  subject: 'Physics',
  has_image_or_diagram: false,
  ...overrides
});

const documentWith = questions => ({ version: '1.0', questions });

test('Stage 23 example and schema describe strict reviewed JSON and preserve numerical zero', () => {
  const parsed = parseImportDocument(IMPORT_EXAMPLE_DOCUMENT);
  assert.equal(parsed.length, 2);
  assert.equal(parsed[1].type, 'NUMERICAL');
  assert.equal(parsed[1].correctAnswer, '0');
  assert.equal(parsed[1].approved, true);

  assert.equal(IMPORT_JSON_SCHEMA_DOCUMENT.additionalProperties, false);
  assert.equal(IMPORT_JSON_SCHEMA_DOCUMENT.properties.questions.maxItems, MAX_IMPORT_QUESTIONS);
  assert.equal(IMPORT_JSON_SCHEMA_DOCUMENT.properties.questions.items.additionalProperties, false);
});

test('Stage 23 file parsing can require an explicit human approval action for every valid row', () => {
  const source = JSON.stringify(documentWith([validMcq()]));
  const [question] = parseImportJsonText(source, [], { requireExplicitApproval: true });
  assert.deepEqual(question.warnings, []);
  assert.equal(question.approved, false);
});

test('Stage 23 UTF-8 parser accepts one leading BOM and rejects malformed or unsafe encoding', () => {
  const source = JSON.stringify(documentWith([validMcq()]));
  assert.equal(parseImportJsonText(`\uFEFF${source}`).length, 1);
  assert.throws(() => parseImportJsonText(source.slice(0, -2)), /malformed or truncated/);
  assert.throws(() => parseImportJsonText(source.replace('Unique', 'Uni\uFFFDque')), /encoding/);
  assert.throws(() => parseImportJsonText(`${source}\u0000`), /encoding/);
  assert.throws(() => parseImportJsonText(`${source.slice(0, 2)}\uFEFF${source.slice(2)}`), /encoding/);
});

test('Stage 23 parser bounds nesting, strings, file size, and the 500-row limit', () => {
  let nested = 'leaf';
  for (let index = 0; index < 14; index += 1) nested = [nested];
  assert.throws(
    () => parseImportDocument({ version: '1.0', questions: [validMcq(1, { unexpected: nested })] }),
    /nesting exceeds/
  );
  assert.throws(
    () => parseImportDocument(documentWith([validMcq(1, { question_text: 'x'.repeat(10001) })])),
    /string longer than 10,000/
  );

  const maximumBatch = Array.from({ length: MAX_IMPORT_QUESTIONS }, (_, index) => validMcq(index + 1));
  const parsedMaximum = parseImportDocument(documentWith(maximumBatch));
  assert.equal(parsedMaximum.length, MAX_IMPORT_QUESTIONS);
  assert.ok(parsedMaximum.every(question => question.approved));
  assert.throws(
    () => parseImportDocument(documentWith([...maximumBatch, validMcq(MAX_IMPORT_QUESTIONS + 1)])),
    /more than 500|limited to 500/
  );
});

test('Stage 23 immediately rejects non-JSON files and declared MIME mismatches', () => {
  for (const name of ['paper.pdf', 'scan.png', 'questions.txt']) {
    assert.match(validateImportFile({ name, size: 100 }).error, /Only reviewed JSON/);
  }
  for (const type of ['application/pdf', 'image/png', 'text/plain']) {
    assert.match(validateImportFile({ name: 'renamed.json', size: 100, type }).error, /not JSON/);
  }
  assert.equal(validateImportFile({ name: 'reviewed.json', size: 100, type: 'application/json' }).valid, true);
});

test('Stage 23 blocks duplicate source IDs and Unicode-normalized duplicate text', () => {
  const duplicateIds = parseImportDocument(documentWith([
    validMcq(1, { id: 'same-id' }),
    validMcq(2, { id: 'same-id' })
  ]));
  assert.ok(duplicateIds.every(question => !question.approved));
  assert.ok(duplicateIds.every(question => question.rowErrors.some(error => error.code === 'ROW_DUPLICATE_SOURCE_ID')));

  const duplicateText = parseImportDocument(documentWith([
    validMcq(1, { question_text: ' VALUE\u00A0 OF  Ｘ ' }),
    validMcq(2, { question_text: 'value of X' })
  ]));
  assert.ok(duplicateText.every(question => !question.approved));
  assert.ok(duplicateText.every(question => question.rowErrors.some(error => error.code === 'ROW_DUPLICATE_IN_FILE')));
});

test('Stage 23 blocks malformed MCQs and unbalanced LaTeX in prompts and options', () => {
  const [malformed] = parseImportDocument(documentWith([validMcq(1, {
    options: [
      { label: 'A', text: 'one' },
      { label: 'C', text: 'two' },
      { label: 'C', text: 'two' },
      { label: 'D', text: 'four' }
    ],
    correct_answer: 'E'
  })]));
  assert.equal(malformed.approved, false);
  assert.ok(malformed.rowErrors.some(error => error.code === 'ROW_DUPLICATE_OPTIONS'));
  assert.ok(malformed.rowErrors.some(error => error.code === 'ROW_INVALID_ANSWER'));
  assert.match(malformed.warnings.join(' '), /label "B"/);

  const latex = parseImportDocument(documentWith([
    validMcq(1, { question_text: 'Solve $x + 1' }),
    validMcq(2, {
      options: [
        { label: 'A', text: '$x' },
        { label: 'B', text: 'two' },
        { label: 'C', text: 'three' },
        { label: 'D', text: 'four' }
      ]
    })
  ]));
  assert.ok(latex.every(question => !question.approved));
  assert.ok(latex[0].rowErrors.some(error => error.code === 'ROW_UNBALANCED_LATEX'));
  assert.ok(latex[1].rowErrors.some(error => error.code === 'ROW_UNBALANCED_OPTION_LATEX'));
});

test('Stage 23 preserves missing-diagram declarations for the activation preflight gate', () => {
  const [question] = parseImportDocument(documentWith([
    validMcq(1, { has_image_or_diagram: true })
  ]));
  assert.equal(question.hasImageOrDiagram, true);
  assert.equal(question.approved, true);
});

test('Stage 23 image validation rejects MIME/content disagreement before upload', async () => {
  const pngHeader = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 0];
  const spoofed = {
    name: 'spoofed.jpg',
    type: 'image/jpeg',
    size: pngHeader.length,
    slice: () => ({ arrayBuffer: async () => new Uint8Array(pngHeader).buffer })
  };
  const result = await validateImageUpload(spoofed);
  assert.equal(result.valid, false);
  assert.match(result.error, /MIME type mismatch/);
});

test('Stage 23 UI is reviewed-JSON-only, human-approved, latest-file-wins, and commit-recoverable', async () => {
  const [importer, dashboard, preflight, storageImage, editor] = await Promise.all([
    readFile(new URL('../src/components/AIQuestionImporter.jsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/components/AdminDashboard.jsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/examPreflightLogic.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/components/StorageImage.jsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/components/QuestionEditor.jsx', import.meta.url), 'utf8')
  ]);

  assert.match(importer, /Reviewed JSON Import/);
  assert.doesNotMatch(importer, /AI Question Importer/);
  assert.doesNotMatch(importer, /EXTRACTION_PROMPT/);
  assert.match(importer, /does not read PDFs, images, OCR output, documents, or invoke an AI service/);
  assert.match(importer, /Download JSON Example/);
  assert.match(importer, /Download JSON Schema/);
  assert.match(importer, /accept="\.json,application\/json"/);
  assert.match(importer, /parseImportJsonText/);
  assert.match(importer, /requireExplicitApproval: true/);
  assert.match(importer, /activeFileReaderRef\.current\?\.abort\(\)/);
  assert.match(importer, /generation !== fileReadGenerationRef\.current/);
  assert.match(importer, /q\.warnings\.length === 0 \? \{ \.\.\.q, approved: !q\.approved \} : q/);
  assert.match(importer, /admin_import_questions/);
  assert.match(importer, /may have committed before the connection failed/);
  assert.match(importer, /retry the same batch safely/);
  assert.match(importer, /required private image/);
  assert.match(importer, /exam cannot be activated while required media is missing/i);
  assert.match(dashboard, /Reviewed JSON Import/);
  assert.doesNotMatch(dashboard, />\s*AI Question Importer\s*</);

  assert.match(preflight, /hasImageOrDiagram && !questionImg/);
  assert.match(storageImage, /createSignedUrl\(src, 60 \* 60\)/);
  assert.match(storageImage, /Date\.now\(\) \+ 55 \* 60 \* 1000/);
  assert.match(editor, /validateImageUpload\(file\)/);
  assert.match(editor, /\.upload\(path, blob, \{ contentType: 'image\/jpeg', upsert: false \}\)/);
  assert.match(editor, /uploadedPathsRef\.current\.filter\(path => !referencedPaths\.has\(path\)\)/);
  assert.match(editor, /if \(saved !== false\) uploadedPathsRef\.current = \[\]/);
  assert.match(editor, /remove\(uploadedPathsRef\.current\)/);
});
