import { object } from './http.ts';
export type ChallengeResult = 'CAPTCHA_REQUIRED' | 'CAPTCHA_INVALID' | 'UNAVAILABLE' | { code: 'OK'; challengeTs: string };
// Conservative hard ceilings. DB policy may tighten them; never extend past them.
export const TURNSTILE_TIME = { maxAgeSeconds: 240, futureSkewSeconds: 30 } as const;
export async function hashTurnstileToken(token: string): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
}
export function freshChallengeTimestamp(value: unknown, now = Date.now()): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)) return false;
  const at = Date.parse(value);
  if (!Number.isFinite(at)) return false;
  const canonical = value.replace(/(?:\.(\d{1,3}))?Z$/, (_match, fraction: string | undefined) => '.' + (fraction ?? '').padEnd(3, '0') + 'Z');
  return new Date(at).toISOString() === canonical && at >= now - TURNSTILE_TIME.maxAgeSeconds * 1000 && at <= now + TURNSTILE_TIME.futureSkewSeconds * 1000;
}
export function createTurnstileVerifier(secret: string | undefined, hostnames: string[], fetcher: typeof fetch = fetch) {
  return async (token: string | undefined): Promise<ChallengeResult> => {
    if (!secret || !hostnames.length || hostnames.some(h => !/^[a-z0-9.-]+$/.test(h))) return 'UNAVAILABLE';
    if (!token) return 'CAPTCHA_REQUIRED';
    if (token.length > 2048) return 'CAPTCHA_INVALID';
    try {
      const response = await fetcher('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ secret, response: token }), signal: AbortSignal.timeout(5000) });
      if (!response.ok) return 'UNAVAILABLE';
      const result = object(await response.json());
      return result?.success === true && result.action === 'create_game' && typeof result.hostname === 'string' && hostnames.includes(result.hostname) && freshChallengeTimestamp(result.challenge_ts)
        ? { code: 'OK', challengeTs: result.challenge_ts } : 'CAPTCHA_INVALID';
    } catch { return 'UNAVAILABLE'; }
  };
}
