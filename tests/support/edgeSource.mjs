// The manage-student Edge Function is split into a request pipeline
// (router.ts), an action table (actions/*.ts) and pure modules (validation.ts,
// http.ts, ...). Source-contract tests read all of it as one text, and
// behavioural tests load the real module graph under Node via loadEdgeModule().
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const FUNCTION_ROOT = 'supabase/functions/manage-student';
const SOURCE_FILE = /\.ts$/;
const ENTRY = `${FUNCTION_ROOT}/index.ts`;

const toRepoPath = absolutePath => relative(repoRoot, absolutePath).split('\\').join('/');

async function list(directory = join(repoRoot, FUNCTION_ROOT)) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async entry => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return list(path);
    return SOURCE_FILE.test(entry.name) ? [toRepoPath(path)] : [];
  }));
  return nested.flat();
}

const entryFirst = paths => [ENTRY, ...paths.filter(path => path !== ENTRY).sort()];

/** Repo-relative paths of every manage-student source file, index.ts first. */
export async function edgeSourceFiles() {
  return entryFirst(await list());
}

/** Concatenated source of supabase/functions/manage-student/**\/*.ts. */
export async function edgeSource() {
  const paths = await edgeSourceFiles();
  const contents = await Promise.all(paths.map(path => readFile(join(repoRoot, path), 'utf8')));
  return paths.map((path, index) => `// ---- ${path}\n${contents[index]}`).join('\n');
}

/**
 * Transpiles the function's modules (types stripped, relative `.ts` imports
 * rewritten to `.js`, the jsr: supabase-js import pointed at the npm package)
 * into a temporary directory and imports the requested modules from one
 * module graph. The function's own code runs unchanged; it only uses
 * web-standard APIs besides the guarded Deno.serve entry.
 *
 * @param {string[]} modules function-relative module paths, e.g. 'actions/index.ts'
 * @returns {Promise<Record<string, any>>} the imported namespaces keyed by path
 */
export async function loadEdgeModules(modules = ['index.ts']) {
  const outDir = await mkdtemp(join(tmpdir(), 'manage-student-'));
  const supabaseJsUrl = import.meta.resolve('@supabase/supabase-js');
  try {
    for (const path of await edgeSourceFiles()) {
      if (path.endsWith('.d.ts')) continue;
      const source = (await readFile(join(repoRoot, path), 'utf8'))
        .replace(/from\s+['"]jsr:@supabase\/supabase-js@2['"]/g, `from '${supabaseJsUrl}'`)
        .replace(/(from\s+['"]\.{1,2}\/[^'"]+)\.ts(['"])/g, '$1.js$2');
      const { outputText } = ts.transpileModule(source, {
        compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, verbatimModuleSyntax: true },
        fileName: path,
      });
      const target = join(outDir, relative(FUNCTION_ROOT, path)).replace(/\.ts$/, '.js');
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, outputText);
    }
    const loaded = {};
    for (const modulePath of modules) {
      loaded[modulePath] = await import(pathToFileURL(join(outDir, modulePath.replace(/\.ts$/, '.js'))).href);
    }
    return loaded;
  } finally {
    // Node has already linked the whole module graph once import() resolves.
    await rm(outDir, { recursive: true, force: true });
  }
}

/** The function's entry module (index.ts) loaded under Node. */
export async function loadEdgeModule() {
  return (await loadEdgeModules(['index.ts']))['index.ts'];
}
