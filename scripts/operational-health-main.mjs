#!/usr/bin/env node
import { readConnectedMain } from './connected-main.mjs';

const main = readConnectedMain();
process.env.SUPABASE_URL = main.url;
process.env.SUPABASE_SERVICE_ROLE_KEY = main.serviceKey;

if (!process.argv.includes('--json')) process.argv.push('--json');
await import('./operational-health-check.mjs');
