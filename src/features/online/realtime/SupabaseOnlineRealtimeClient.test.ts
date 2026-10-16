import type { SupabaseClient } from '@supabase/supabase-js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '../../../shared/lib/supabase/database.types';
import { existingGameId, unknownGameId } from '../../../test/onlineFixtures';
import { SupabaseOnlineRealtimeClient, parseVersionSignal } from './SupabaseOnlineRealtimeClient';

afterEach(() => vi.useRealTimers());
function setup() {
  const channels: { broadcast?: (value: { payload: unknown }) => void; status?: (status: string) => void; on: ReturnType<typeof vi.fn>; subscribe: ReturnType<typeof vi.fn> }[] = [];
  const channel = vi.fn(() => {
    const item: typeof channels[number] = { on: vi.fn(), subscribe: vi.fn() };
    item.on.mockImplementation((_type, _filter, callback) => { item.broadcast = callback; return item; });
    item.subscribe.mockImplementation(callback => { item.status = callback; return item; }); channels.push(item); return item;
  });
  const removeChannel = vi.fn(async () => 'ok');
  const realtime = new SupabaseOnlineRealtimeClient({ channel, removeChannel } as unknown as SupabaseClient<Database>);
  const handlers = { onVersion: vi.fn(), onStatus: vi.fn() };
  const subscription = realtime.subscribe(existingGameId, handlers);
  return { channels, channel, removeChannel, handlers, subscription };
}

describe('Supabase Broadcast transport', () => {
  it('accepts only a minimal signal for this game, including optional upstream message ID', () => {
    expect(parseVersionSignal({ game_id: existingGameId, version: 2, id: unknownGameId }, existingGameId)).toEqual({ gameId: existingGameId, version: 2 });
    for (const payload of [{ game_id: unknownGameId, version: 2 }, { game_id: existingGameId, version: 0 }, { game_id: existingGameId, version: '2' }, { game_id: existingGameId, version: 2, creator_token_hash: 'not allowed' }]) expect(parseVersionSignal(payload, existingGameId)).toBeNull();
  });
  it('subscribes only to the public version topic, not postgres_changes or a row stream', () => {
    const h = setup();
    expect(h.channel).toHaveBeenCalledWith(`online-game:${existingGameId}`, { config: { private: false, broadcast: { self: false, ack: false } } });
    expect(h.channels[0].on.mock.calls[0].slice(0, 2)).toEqual(['broadcast', { event: 'version_changed' }]);
    h.channels[0].broadcast!({ payload: { game_id: existingGameId, version: 3 } });
    expect(h.handlers.onVersion).toHaveBeenCalledWith({ gameId: existingGameId, version: 3 });
    h.subscription.unsubscribe();
  });
  it('retries transport failures and guards callbacks from the old channel', async () => {
    vi.useFakeTimers(); const h = setup(); h.channels[0].status!('CHANNEL_ERROR');
    expect(h.handlers.onStatus).toHaveBeenLastCalledWith('reconnecting');
    await vi.advanceTimersByTimeAsync(1000); expect(h.removeChannel).toHaveBeenCalledWith(h.channels[0]); expect(h.channels).toHaveLength(2);
    h.channels[0].broadcast!({ payload: { game_id: existingGameId, version: 99 } }); expect(h.handlers.onVersion).not.toHaveBeenCalled();
    h.channels[1].status!('SUBSCRIBED'); expect(h.handlers.onStatus).toHaveBeenLastCalledWith('online');
    h.subscription.unsubscribe(); await vi.advanceTimersByTimeAsync(30000); expect(h.channels).toHaveLength(2);
  });
  it('removes subscriptions on unmount and ignores a late callback', async () => {
    const h = setup(); h.subscription.unsubscribe(); h.subscription.unsubscribe();
    h.channels[0].broadcast!({ payload: { game_id: existingGameId, version: 2 } });
    expect(h.handlers.onVersion).not.toHaveBeenCalled(); expect(h.removeChannel).toHaveBeenCalledTimes(1);
  });
});
