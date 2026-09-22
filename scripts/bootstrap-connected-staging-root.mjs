import { readConnectedStaging } from './connected-staging.mjs';

process.env.REHEARSAL_CONFIRM_DISPOSABLE = 'YES_RESET_THIS_DISPOSABLE_PROJECT_AFTER_REHEARSAL';
const staging = readConnectedStaging();
process.env.SUPABASE_URL = staging.url;
process.env.SUPABASE_SERVICE_ROLE_KEY = staging.serviceKey;
await import('./bootstrap-admin.mjs');
