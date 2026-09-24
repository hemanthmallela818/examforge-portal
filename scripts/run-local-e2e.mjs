#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const supabaseCli = fileURLToPath(new URL('../node_modules/supabase/dist/supabase.js', import.meta.url));
const playwrightCli = fileURLToPath(new URL('../node_modules/@playwright/test/cli.js', import.meta.url));
const commandEnvironment = {
  ...process.env,
  SUPABASE_TELEMETRY_DISABLED: '1',
  DO_NOT_TRACK: '1'
};

const runSync = (entry, args) => {
  const result = spawnSync(process.execPath, [entry, ...args], {
    cwd: process.cwd(),
    env: commandEnvironment,
    stdio: 'inherit'
  });
  if (result.error) throw result.error;
  return result.status ?? 1;
};

if (runSync(supabaseCli, ['start']) !== 0) process.exit(1);
if (runSync(supabaseCli, ['db', 'reset', '--local']) !== 0) process.exit(1);
// `db reset` removes the local Edge runtime container on current Supabase CLI
// releases. A second start recreates it before `functions serve` attaches.
if (runSync(supabaseCli, ['start']) !== 0) process.exit(1);

const functionServer = spawn(process.execPath, [supabaseCli, 'functions', 'serve'], {
  cwd: process.cwd(),
  env: commandEnvironment,
  stdio: ['ignore', 'pipe', 'pipe']
});

let startupOutput = '';
const mirrorOutput = chunk => {
  const text = chunk.toString();
  startupOutput += text;
  process.stdout.write(text);
};
functionServer.stdout.on('data', mirrorOutput);
functionServer.stderr.on('data', mirrorOutput);

const waitForFunctionServer = new Promise((resolve, reject) => {
  const timeout = setTimeout(() => {
    reject(new Error(`Timed out waiting for the local Edge Function runtime.\n${startupOutput}`));
  }, 120_000);

  const inspect = () => {
    if (/Serving functions on/i.test(startupOutput)) {
      clearTimeout(timeout);
      resolve();
    }
  };

  functionServer.stdout.on('data', inspect);
  functionServer.stderr.on('data', inspect);
  functionServer.once('exit', code => {
    clearTimeout(timeout);
    reject(new Error(`Local Edge Function runtime exited before it was ready (code ${code}).\n${startupOutput}`));
  });
});

let exitCode;
try {
  await waitForFunctionServer;
  exitCode = runSync(playwrightCli, ['test', ...process.argv.slice(2)]);
} finally {
  functionServer.kill();
}

process.exitCode = exitCode;
