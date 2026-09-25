// The administrator dashboard is split between the thin shell in
// src/components/AdminDashboard.jsx and the feature modules under
// src/features/admin/. Source-contract tests read all of it as one text so
// their assertions keep covering the whole administrator UI.
import { readdirSync, readFileSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const SHELL_PATH = 'src/components/AdminDashboard.jsx';
const FEATURE_ROOT = 'src/features/admin';
const SOURCE_FILE = /\.(?:js|jsx)$/;

const toRepoPath = absolutePath => relative(repoRoot, absolutePath).split('\\').join('/');

function listFeatureFilesSync(directory = join(repoRoot, FEATURE_ROOT)) {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap(entry => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return listFeatureFilesSync(path);
      return SOURCE_FILE.test(entry.name) ? [toRepoPath(path)] : [];
    });
}

async function listFeatureFiles(directory = join(repoRoot, FEATURE_ROOT)) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async entry => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return listFeatureFiles(path);
    return SOURCE_FILE.test(entry.name) ? [toRepoPath(path)] : [];
  }));
  return nested.flat();
}

/** Repo-relative paths of every administrator dashboard source file, shell first. */
export function adminSourceFilesSync() {
  return [SHELL_PATH, ...listFeatureFilesSync().sort()];
}

export async function adminSourceFiles() {
  return [SHELL_PATH, ...(await listFeatureFiles()).sort()];
}

/** Concatenated source of AdminDashboard.jsx and src/features/admin/**\/*.js(x). */
export function adminSourceSync() {
  return adminSourceFilesSync()
    .map(path => `// ---- ${path}\n${readFileSync(join(repoRoot, path), 'utf8')}`)
    .join('\n');
}

export async function adminSource() {
  const paths = await adminSourceFiles();
  const contents = await Promise.all(paths.map(path => readFile(join(repoRoot, path), 'utf8')));
  return paths.map((path, index) => `// ---- ${path}\n${contents[index]}`).join('\n');
}
