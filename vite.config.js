import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => {
  const fileEnv = loadEnv(mode, process.cwd(), '')
  const publicSupabaseUrl = process.env.SUPABASE_URL || fileEnv.VITE_SUPABASE_URL || ''
  const publicSupabaseKey =
    process.env.SUPABASE_PUBLISHABLE_KEY ||
    process.env.SUPABASE_ANON_KEY ||
    fileEnv.VITE_SUPABASE_ANON_KEY ||
    ''

  return {
    plugins: [react(), tailwindcss()],
    // Vercel's Supabase integration exposes browser-safe values without the
    // VITE_ prefix. Map only those public values into the client build and
    // never reference SUPABASE_SECRET_KEY or SUPABASE_SERVICE_ROLE_KEY here.
    define: {
      'import.meta.env.VITE_SUPABASE_URL': JSON.stringify(publicSupabaseUrl),
      'import.meta.env.VITE_SUPABASE_ANON_KEY': JSON.stringify(publicSupabaseKey)
    }
  }
})
