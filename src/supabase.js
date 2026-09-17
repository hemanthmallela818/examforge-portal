import { createClient } from '@supabase/supabase-js';
import { validateRuntimeConfiguration } from './runtimeConfig';

export const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
export const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

const configuration = validateRuntimeConfiguration(supabaseUrl, supabaseAnonKey);
if (!configuration.valid) {
  throw new Error(`Invalid public service configuration: ${configuration.errors.join(' ')}`);
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: false
  }
});
