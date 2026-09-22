import { readConnectedMain } from './connected-main.mjs';

const main = readConnectedMain();
process.env.SUPABASE_URL = main.url;
process.env.SUPABASE_SERVICE_ROLE_KEY = main.serviceKey;
await import('./bootstrap-admin.mjs');
