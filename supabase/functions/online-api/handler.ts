import { admit, type LimitedBackend } from '../_shared/limiter.ts';
import { corsHeaders, object, readBody, reply, validId, validToken } from '../_shared/http.ts';
import type { ChallengeResult } from '../_shared/turnstile.ts';
export interface OnlineApiBackend extends LimitedBackend {
  create(id: string, choice: string, token: string): Promise<unknown>;
  join(id: string, token: string): Promise<unknown>;
}
export function createOnlineApiHandler(backend: OnlineApiBackend, verify: (token: string | undefined) => Promise<ChallengeResult>) {
  return async (request: Request): Promise<Response> => {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders });
    if (request.method !== 'POST') return new Response(null, { status: 405, headers: corsHeaders });
    let body: Record<string, unknown> | null;
    try { body = await readBody(request); } catch { return reply('INVALID_REQUEST'); }
    if (!body || typeof body.action !== 'string' || !['create','join','read'].includes(body.action) || !validId(body.game_id)) return reply('INVALID_REQUEST');
    const operation = body.action as 'create' | 'join' | 'read';
    const allowed = operation === 'create' ? ['action','game_id','player_token','color_choice','turnstile_token'] : ['action','game_id','player_token'];
    if (Object.keys(body).some(key => !allowed.includes(key)) || !(operation === 'read' && body.player_token === null) && !validToken(body.player_token)) return reply('INVALID_REQUEST');
    if (operation === 'create' && (typeof body.color_choice !== 'string' || !['white','black','random'].includes(body.color_choice) || body.turnstile_token !== undefined && (typeof body.turnstile_token !== 'string' || body.turnstile_token.length > 2048))) return reply('INVALID_REQUEST');
    const id = body.game_id.toLowerCase(); const token = body.player_token as string | null;
    try {
      const admission = await admit(backend, operation, id, token);
      if (admission.code !== 'OK') return reply(admission.code, { ...(admission.retry_after ? { retry_after: admission.retry_after } : {}) });
      if (admission.existing_session) return reply('OK', { session: admission.existing_session });
      if (operation === 'read') {
        if (!object(admission.session)) return reply('UNAVAILABLE');
        return reply('OK', { session: admission.session });
      }
      if (operation === 'create') {
        const challenge = await verify(body.turnstile_token as string | undefined);
        if (challenge !== 'OK') return reply(challenge);
      }
      const result = object(operation === 'create' ? await backend.create(id, body.color_choice as string, token!) : await backend.join(id, token!));
      if (!result || typeof result.code !== 'string') return reply('UNAVAILABLE');
      if (result.code === 'OK' && !object(result.session)) return reply('UNAVAILABLE');
      return reply(result.code, { ...(result.session ? { session: result.session } : {}), ...(result.retry_after ? { retry_after: result.retry_after } : {}) });
    } catch { return reply('UNAVAILABLE'); }
  };
}
