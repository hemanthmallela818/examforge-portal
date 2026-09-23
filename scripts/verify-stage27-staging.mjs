import { createClient } from '@supabase/supabase-js';
import { readConnectedStaging } from './connected-staging.mjs';
import { readConnectedMain } from './connected-main.mjs';

const useMain = process.argv.includes('--main');
if (!useMain) process.env.REHEARSAL_CONFIRM_DISPOSABLE = 'YES_RESET_THIS_DISPOSABLE_PROJECT_AFTER_REHEARSAL';
const staging = useMain ? readConnectedMain() : readConnectedStaging();
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

const exam = await root.from('cbt_exams').select('id,status').order('created_at', { ascending: false }).limit(1).single();
if (exam.error || !exam.data?.id) throw new Error(`No connected-project exam is available: ${exam.error?.message || 'unknown error'}`);

const [page, health, size] = await Promise.all([
  root.rpc('get_admin_exam_results_page', {
    exam_id_param: exam.data.id,
    page_number_param: 0,
    page_size_param: 100,
    search_param: null,
    expected_result_count_param: null
  }),
  root.rpc('admin_operational_health'),
  root.rpc('get_db_size')
]);
if (page.error) throw new Error(`Administrator results failed: ${page.error.message}`);
if (health.error) throw new Error(`Operational health failed: ${health.error.message}`);
if (size.error) throw new Error(`Database size failed: ${size.error.message}`);

const statusProbe = await root.from('cbt_exams').update({ status: exam.data.status }).eq('id', exam.data.id).select('id,status').single();
if (statusProbe.error) throw new Error(`Administrator exam status authorization failed: ${statusProbe.error.message}`);

console.log(JSON.stringify({
  verified: true,
  target: useMain ? 'main' : 'staging',
  administratorResults: true,
  administratorHealth: true,
  databaseSize: true,
  examStatusAuthorization: true,
  resultCount: Number(page.data?.result_count || 0)
}));
