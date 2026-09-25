// Source-contract tests used to read src/App.jsx alone. The student exam
// session now lives in src/features/exam/**, so contracts about the exam
// session read App.jsx plus every module under src/features/exam, in a stable
// order (App.jsx first, then feature files sorted by path).
import { readFileSync, readdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const featureDir = join(root, 'src/features/exam');

const listFeatureFiles = (dir) => readdirSync(dir, { withFileTypes: true })
  .flatMap(entry => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return listFeatureFiles(path);
    return /\.(?:js|jsx)$/.test(entry.name) ? [path] : [];
  });

/** Repository-relative paths of the files that make up the exam shell and session. */
export const examSourceFiles = () => [
  'src/App.jsx',
  ...listFeatureFiles(featureDir).map(path => relative(root, path)).sort()
];

const join2 = (contents) => contents.join('\n');

/** App.jsx + src/features/exam/** concatenated, synchronously. */
export const readExamSourceSync = () => join2(examSourceFiles().map(path => readFileSync(join(root, path), 'utf8')));

/** App.jsx + src/features/exam/** concatenated. */
export const readExamSource = async () => join2(await Promise.all(examSourceFiles().map(path => readFile(join(root, path), 'utf8'))));
