import { createClient } from '@supabase/supabase-js';
import { createOnlineBackend } from '../_shared/backend.ts';
import { createTurnstileVerifier } from '../_shared/turnstile.ts';
import { createOnlineApiHandler } from './handler.ts';
const url = Deno.env.get('SUPABASE_URL');
const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
if (!url || !key) throw new Error('Missing server configuration');
const backend = createOnlineBackend(createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } }));
Deno.serve(createOnlineApiHandler(backend, createTurnstileVerifier(Deno.env.get('TURNSTILE_SECRET_KEY'), (Deno.env.get('TURNSTILE_ALLOWED_HOSTNAMES') ?? '').split(',').map(x => x.trim()).filter(Boolean))));
