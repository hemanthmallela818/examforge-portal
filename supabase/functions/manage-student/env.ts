// Reads configuration under Deno (production) and Node (source-contract tests).
export function getEnv(key: string): string {
  try {
    if (typeof Deno !== 'undefined' && Deno?.env?.get) {
      return Deno.env.get(key) || '';
    }
  } catch {}
  try {
    if (typeof process !== 'undefined' && process?.env) {
      return process.env[key] || '';
    }
  } catch {}
  return '';
}
