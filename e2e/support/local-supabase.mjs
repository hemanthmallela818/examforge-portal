import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost']);
const CLI_WRAPPER = fileURLToPath(new URL('../../scripts/run-supabase.mjs', import.meta.url));

const parseStatusOutput = raw => {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('Local Supabase status did not return JSON configuration.');
  return JSON.parse(raw.slice(start, end + 1));
};

export const readLocalSupabase = () => {
  if (process.env.E2E_SUPABASE_URL && process.env.E2E_SUPABASE_ANON_KEY && process.env.E2E_SUPABASE_SERVICE_ROLE_KEY) {
    const url = new URL(process.env.E2E_SUPABASE_URL);
    if (!LOCAL_HOSTS.has(url.hostname)) throw new Error('E2E tests are restricted to a local Supabase host.');
    return {
      url: url.origin,
      anonKey: process.env.E2E_SUPABASE_ANON_KEY,
      serviceRoleKey: process.env.E2E_SUPABASE_SERVICE_ROLE_KEY
    };
  }

  let output;
  try {
    output = execFileSync(
      process.execPath,
      [CLI_WRAPPER, 'status', '--output', 'json'],
      { cwd: process.cwd(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
    );
  } catch (error) {
    throw new Error(`The local Supabase stack is unavailable: ${error.stderr || error.message}`);
  }
  const status = parseStatusOutput(output);
  const url = new URL(status.API_URL);
  if (!LOCAL_HOSTS.has(url.hostname)) throw new Error('Refusing to run E2E fixtures against a non-local Supabase host.');
  if (!status.ANON_KEY || !status.SERVICE_ROLE_KEY) throw new Error('Local Supabase keys were not available.');
  return { url: url.origin, anonKey: status.ANON_KEY, serviceRoleKey: status.SERVICE_ROLE_KEY };
};
