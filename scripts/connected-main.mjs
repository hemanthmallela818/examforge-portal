import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

export const readConnectedMain = () => {
  const projectRef = 'hetaoesxoicqreobjqpy';
  const cli = spawnSync(process.execPath, [resolve('node_modules/supabase/dist/supabase.js'),
    'projects', 'api-keys', '--project-ref', projectRef, '--reveal', '--output', 'json'], {
    encoding: 'utf8', timeout: 60_000,
    env: { ...process.env, SUPABASE_TELEMETRY_DISABLED: '1', DO_NOT_TRACK: '1' }
  });
  if (cli.error || cli.status !== 0) throw new Error('Main-project key lookup failed; no credentials were logged.');
  let keys;
  try { keys = JSON.parse(cli.stdout); } catch { throw new Error('Main-project key response was not JSON.'); }
  const serviceKey = keys.find(key => key.name === 'service_role')?.api_key;
  const publicKey = keys.find(key => key.type === 'publishable')?.api_key
    || keys.find(key => key.name === 'anon')?.api_key;
  if (!serviceKey || !publicKey) throw new Error('Required main-project keys are unavailable.');
  return { projectRef, serviceKey, publicKey, url: `https://${projectRef}.supabase.co` };
};
