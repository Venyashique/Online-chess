import { useEffect, useRef, useState } from 'react';
type Turnstile = { render(element: HTMLElement, options: Record<string, unknown>): string; remove(id: string): void };
type ChallengeWindow = Window & { turnstile?: Turnstile };
let loading: Promise<Turnstile> | undefined;
function load() {
  if ((window as ChallengeWindow).turnstile) return Promise.resolve((window as ChallengeWindow).turnstile!);
  if (!loading) loading = new Promise<Turnstile>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'; script.async = true;
    const timer = setTimeout(() => reject(new Error('Challenge unavailable')), 10000);
    script.onload = () => { clearTimeout(timer); const api = (window as ChallengeWindow).turnstile; if (api) resolve(api); else reject(new Error('Challenge unavailable')); };
    script.onerror = () => { clearTimeout(timer); reject(new Error('Challenge unavailable')); };
    document.head.append(script);
  });
  return loading;
}
export function TurnstileChallenge({ onToken, resetKey }: { onToken(token: string | null): void; resetKey: number }) {
  const element = useRef<HTMLDivElement>(null); const [failed, setFailed] = useState(false);
  const key = import.meta.env.VITE_TURNSTILE_SITE_KEY?.trim();
  useEffect(() => {
    if (!key) return;
    let alive = true; let widget: string | undefined; let api: Turnstile | undefined;
    setFailed(false); onToken(null);
    void load().then(client => {
      if (!alive || !element.current) return; api = client;
      widget = client.render(element.current, { sitekey: key, action: 'create_game', callback: (token: string) => { if (alive) onToken(typeof token === 'string' && token.length <= 2048 ? token : null); }, 'expired-callback': () => { if (alive) onToken(null); }, 'error-callback': () => { if (alive) { setFailed(true); onToken(null); } } });
    }).catch(() => { if (alive) { setFailed(true); onToken(null); } });
    return () => { alive = false; if (widget !== undefined) api?.remove(widget); };
  }, [key, resetKey, onToken]);
  return <div><div ref={element} />{!key ? <p>Создание партий пока не настроено. Просмотр и существующие партии доступны.</p> : failed ? <p role="status">Не удалось загрузить проверку. Обновите страницу и попробуйте снова.</p> : null}</div>;
}
