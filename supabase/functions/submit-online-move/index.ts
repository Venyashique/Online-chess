import { createClient } from '@supabase/supabase-js';
import { createOnlineBackend } from '../_shared/backend.ts';
import { createSubmitMoveHandler } from './handler.ts';
const url = Deno.env.get('SUPABASE_URL');
const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
if (!url || !key) throw new Error('Missing server configuration');
Deno.serve(createSubmitMoveHandler(createOnlineBackend(createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } }))));
