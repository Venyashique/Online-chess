export const HTTP_POLICY = { maxBodyBytes: 4096, bodyTimeoutMs: 5000, retrySeconds: 5 } as const;
export const object = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
export const validId = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
export const validToken = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const codes: Record<string, number> = { OK: 200, INVALID_REQUEST: 400, CAPTCHA_REQUIRED: 400, CAPTCHA_INVALID: 400, INVALID_TOKEN: 403, NOT_YOUR_TURN: 403, NOT_FOUND: 404, GAME_EXPIRED: 410, INVALID_MOVE: 422, RATE_LIMITED: 429, CAPACITY_REACHED: 429, UNAVAILABLE: 503, NOT_READY: 409, VERSION_CONFLICT: 409, GAME_OVER: 409, GAME_FULL: 409, GAME_EXISTS: 409, LEGACY_READ_ONLY: 409 };
export function reply(code: string, payload: Record<string, unknown> = {}) {
  if (!Object.hasOwn(codes, code)) { code = 'UNAVAILABLE'; payload = {}; }
  const status = codes[code];
  const retry = status === 429 || status === 503 ? Math.min(86400, Math.max(1, Math.ceil(Number(payload.retry_after) || HTTP_POLICY.retrySeconds))) : null;
  return new Response(JSON.stringify({ code, ...payload, ...(retry ? { retry_after: retry } : {}) }), { status, headers: { ...corsHeaders, ...(retry ? { 'Retry-After': String(retry) } : {}) } });
}
export const corsHeaders = {
  'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
  'Access-Control-Expose-Headers': 'Retry-After', 'Cache-Control': 'no-store', 'Content-Type': 'application/json',
};
export async function readBody(request: Request): Promise<Record<string, unknown> | null> {
  if (!request.body || Number(request.headers.get('content-length') || 0) > HTTP_POLICY.maxBodyBytes) throw new Error('Invalid body');
  const reader = request.body.getReader();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => { reject(new Error('Body timeout')); void reader.cancel().catch(() => {}); }, HTTP_POLICY.bodyTimeoutMs); });
  try {
    const chunks: Uint8Array[] = []; let size = 0;
    for (;;) {
      const { value, done } = await Promise.race([reader.read(), timeout]); if (done) break;
      size += value.length;
      if (size > HTTP_POLICY.maxBodyBytes) { void reader.cancel().catch(() => {}); throw new Error('Body too large'); }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    return object(JSON.parse(new TextDecoder().decode(bytes)));
  } finally { clearTimeout(timer); reader.releaseLock(); }
}
