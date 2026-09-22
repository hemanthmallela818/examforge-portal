import { createClient } from '@supabase/supabase-js';
import { readConnectedStaging } from './connected-staging.mjs';

process.env.REHEARSAL_CONFIRM_DISPOSABLE = 'YES_RESET_THIS_DISPOSABLE_PROJECT_AFTER_REHEARSAL';
const staging = readConnectedStaging();
const options = { auth: { persistSession: false, autoRefreshToken: false } };
const service = createClient(staging.url, staging.serviceKey, options);
const root = createClient(staging.url, staging.publicKey, options);

const owner = await service.from('application_owner').select('user_id').single();
if (owner.error || !owner.data?.user_id) throw new Error('Staging root owner is not registered.');
const ownerUser = await service.auth.admin.getUserById(owner.data.user_id);
const ownerEmail = ownerUser.data?.user?.email;
if (ownerUser.error || !ownerEmail) throw new Error('Staging root Auth account is unavailable.');
const ownerLink = await service.auth.admin.generateLink({ type: 'magiclink', email: ownerEmail });
const tokenHash = ownerLink.data?.properties?.hashed_token;
if (ownerLink.error || !tokenHash) throw new Error('Could not create a staging root verification session.');
const login = await root.auth.verifyOtp({ type: 'magiclink', token_hash: tokenHash });
if (login.error) throw new Error(`Root session verification failed: ${login.error.message}`);

const preview = await root.functions.invoke('manage-student', { body: { action: 'preview-reset' } });
if (preview.error || !preview.data?.preview) {
  throw new Error(`Root reset preview failed: ${preview.data?.error || preview.error?.message || 'unknown error'}`);
}
console.log(JSON.stringify({ verified: true, rootOnlyPreview: true, preview: preview.data.preview }));
