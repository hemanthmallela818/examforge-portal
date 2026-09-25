import { createClient } from 'jsr:@supabase/supabase-js@2';
import { getEnv } from './env.ts';
import type { AdminClient, CallerClient, ManageStudentClients } from './types.ts';

/**
 * The caller client carries the request's JWT (RLS and auth.uid() apply); the
 * admin client uses the service role and never leaves this function. The
 * supabase-js clients are narrowed here to the minimal interfaces in types.ts.
 */
export function createSupabaseClients(authorization: string): ManageStudentClients {
  const url = getEnv('SUPABASE_URL');
  const anonKey = getEnv('SUPABASE_ANON_KEY');
  const serviceRoleKey = getEnv('SUPABASE_SERVICE_ROLE_KEY');

  const caller = createClient(url, anonKey, {
    global: { headers: { Authorization: authorization } },
    auth: { persistSession: false, autoRefreshToken: false },
  }) as unknown as CallerClient;
  const admin = createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  }) as unknown as AdminClient;
  return { caller, admin };
}
