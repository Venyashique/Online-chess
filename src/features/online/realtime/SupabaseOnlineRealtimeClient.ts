import type { RealtimeChannel, SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '../../../shared/lib/supabase/database.types';
import { isGameId } from '../model/types';
import type { OnlineRealtimeClient, RealtimeHandlers, VersionSignal } from './types';

export const onlineGameTopic = (id: string) => `online-game:${id.toLowerCase()}`;

export function parseVersionSignal(value: unknown, expectedId: string): VersionSignal | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const data = value as Record<string, unknown>;
  if (Object.keys(data).some(key => !['game_id', 'version', 'id'].includes(key)) ||
    (data.id !== undefined && (typeof data.id !== 'string' || !isGameId(data.id))) || typeof data.game_id !== 'string' || !isGameId(data.game_id)
    || data.game_id.toLowerCase() !== expectedId.toLowerCase() || !Number.isSafeInteger(data.version)
    || Number(data.version) < 1 || Number(data.version) > 2147483647) return null;
  return { gameId: data.game_id.toLowerCase(), version: Number(data.version) };
}

/** Public, read-capability topic. Only ID/version hints, never credentials or a
 * database row. A public sender can spoof a hint; the RPC remains authoritative. */
export class SupabaseOnlineRealtimeClient implements OnlineRealtimeClient {
  constructor(private readonly client: SupabaseClient<Database>) {}
  subscribe(id: string, handlers: RealtimeHandlers) {
    if (!isGameId(id)) throw new Error('Некорректный ID подписки.');
    let channel: RealtimeChannel | null = null;
    let disposed = false;
    let restarting = false;
    let failures = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const clearTimer = () => { if (timer) clearTimeout(timer); timer = undefined; };
    const scheduleRetry = () => {
      if (disposed || timer) return;
      const delay = [1000, 2000, 5000, 10000, 30000][Math.min(failures++, 4)];
      timer = setTimeout(() => { timer = undefined; void restart(); }, delay);
    };
    const remove = async (old: RealtimeChannel) => { try { await this.client.removeChannel(old); } catch { /* No stale callbacks may act even if transport cleanup fails. */ } };
    const open = () => {
      if (disposed) return;
      try {
        const current = this.client.channel(onlineGameTopic(id), { config: { private: false, broadcast: { self: false, ack: false } } });
        channel = current;
        current.on('broadcast', { event: 'version_changed' }, ({ payload }) => {
          if (disposed || channel !== current) return;
          const signal = parseVersionSignal(payload, id);
          if (signal) handlers.onVersion(signal);
        }).subscribe(status => {
          if (disposed || channel !== current) return;
          if (status === 'SUBSCRIBED') { clearTimer(); failures = 0; handlers.onStatus('online'); }
          else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
            handlers.onStatus('reconnecting'); scheduleRetry();
          }
        });
      } catch { handlers.onStatus('offline'); scheduleRetry(); }
    };
    const restart = async () => {
      if (disposed || restarting) return;
      restarting = true; clearTimer();
      const old = channel; channel = null;
      handlers.onStatus('reconnecting');
      if (old) await remove(old);
      restarting = false;
      if (!disposed) open();
    };
    handlers.onStatus('connecting'); open();
    return {
      reconnect: () => { void restart(); },
      unsubscribe: () => {
        if (disposed) return;
        disposed = true; clearTimer(); const old = channel; channel = null;
        if (old) void remove(old);
      },
    };
  }
}
