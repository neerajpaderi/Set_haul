import { createClient } from '@supabase/supabase-js';

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_KEY;

if (!url || !key) {
  throw new Error('SUPABASE_URL and SUPABASE_KEY must be set (server-side only, see .env.example).');
}

console.log(`[server] Supabase client initialized for ${url}`);

// Service-role client — bypasses RLS. Must only ever be imported from
// server-side modules (server.ts, server/*), never from src/.
export const supabase = createClient(url, key, {
  auth: { persistSession: false },
});
