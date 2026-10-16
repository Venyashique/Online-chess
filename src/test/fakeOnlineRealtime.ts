import { vi } from 'vitest';
import type { OnlineRealtimeClient, RealtimeHandlers } from '../features/online/realtime/types';

export function fakeOnlineRealtime() {
  const subscriptions: { id: string; handlers: RealtimeHandlers; unsubscribe: ReturnType<typeof vi.fn>; reconnect: ReturnType<typeof vi.fn> }[] = [];
  const client: OnlineRealtimeClient = {
    subscribe(id, handlers) {
      const subscription = { id, handlers, unsubscribe: vi.fn(), reconnect: vi.fn() };
      subscriptions.push(subscription); handlers.onStatus('connecting'); return subscription;
    },
  };
  return { client, subscriptions,
    version: (version: number, index = subscriptions.length - 1) => subscriptions[index].handlers.onVersion({ gameId: subscriptions[index].id, version }),
    status: (status: Parameters<RealtimeHandlers['onStatus']>[0], index = subscriptions.length - 1) => subscriptions[index].handlers.onStatus(status),
  };
}
