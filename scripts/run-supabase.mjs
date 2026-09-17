#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cliEntry = fileURLToPath(new URL('../node_modules/supabase/dist/supabase.js', import.meta.url));
const result = spawnSync(process.execPath, [cliEntry, ...process.argv.slice(2)], {
  cwd: process.cwd(),
  stdio: 'inherit',
  env: {
    ...process.env,
    SUPABASE_TELEMETRY_DISABLED: '1',
    DO_NOT_TRACK: '1'
  }
});

if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
