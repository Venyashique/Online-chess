import { object } from './http.ts';
export type ChallengeResult = 'OK' | 'CAPTCHA_REQUIRED' | 'CAPTCHA_INVALID' | 'UNAVAILABLE';
export function createTurnstileVerifier(secret: string | undefined, hostnames: string[], fetcher: typeof fetch = fetch) {
  return async (token: string | undefined): Promise<ChallengeResult> => {
    if (!secret || !hostnames.length || hostnames.some(h => !/^[a-z0-9.-]+$/.test(h))) return 'UNAVAILABLE';
    if (!token) return 'CAPTCHA_REQUIRED';
    if (token.length > 2048) return 'CAPTCHA_INVALID';
    try {
      const response = await fetcher('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ secret, response: token }), signal: AbortSignal.timeout(5000) });
      if (!response.ok) return 'UNAVAILABLE';
      const result = object(await response.json());
      return result?.success === true && result.action === 'create_game' && typeof result.hostname === 'string' && hostnames.includes(result.hostname) ? 'OK' : 'CAPTCHA_INVALID';
    } catch { return 'UNAVAILABLE'; }
  };
}
