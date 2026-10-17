import { act, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { TurnstileChallenge } from './TurnstileChallenge';
afterEach(() => { vi.unstubAllEnvs(); delete (window as Window & { turnstile?: unknown }).turnstile; });
it('does not issue a proof or load third-party scripts without a site key', () => {
  vi.stubEnv('VITE_TURNSTILE_SITE_KEY', ''); const onToken = vi.fn(); render(<TurnstileChallenge onToken={onToken} resetKey={0} />);
  expect(screen.getByText(/Создание партий пока не настроено/)).toBeVisible(); expect(onToken).not.toHaveBeenCalled(); expect(document.querySelector('script[src*="challenges.cloudflare.com"]')).toBeNull();
});
it('uses explicit create_game action, invalidates expiry and removes old widgets', async () => {
  vi.stubEnv('VITE_TURNSTILE_SITE_KEY', 'public-site-key'); const renderWidget = vi.fn((_element: HTMLElement, _options: Record<string, unknown>) => 'widget'); const remove = vi.fn();
  Object.assign(window, { turnstile: { render: renderWidget, remove } }); const onToken = vi.fn();
  const h = render(<TurnstileChallenge onToken={onToken} resetKey={0} />); await act(async () => {});
  const options = renderWidget.mock.calls[0][1] as any; expect(options.action).toBe('create_game'); expect(options.sitekey).toBe('public-site-key');
  act(() => options.callback('proof')); expect(onToken).toHaveBeenLastCalledWith('proof'); act(() => options['expired-callback']()); expect(onToken).toHaveBeenLastCalledWith(null);
  h.rerender(<TurnstileChallenge onToken={onToken} resetKey={1} />); await act(async () => {}); expect(remove).toHaveBeenCalledWith('widget'); expect(renderWidget).toHaveBeenCalledTimes(2); h.unmount();
});
