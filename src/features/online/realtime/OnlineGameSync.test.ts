import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OnlineGameSync } from './OnlineGameSync';
import { restorePlayerSession } from '../model/OnlinePlayerService';
import { existingGameId, onlineGameFixture, playerSessionFixture } from '../../../test/onlineFixtures';
import type { OnlinePlayerSession } from '../model/OnlinePlayerService';

const snapshot = (version: number) => restorePlayerSession(playerSessionFixture(onlineGameFixture({ version })), existingGameId);
const flush = async () => { await vi.advanceTimersByTimeAsync(0); };
const instances: OnlineGameSync[] = [];
function setup() {
  const pending: { signal: AbortSignal; resolve: (session: OnlinePlayerSession) => void; reject: (error: Error) => void }[] = [];
  const load = vi.fn((signal: AbortSignal) => new Promise<OnlinePlayerSession>((resolve, reject) => pending.push({ signal, resolve, reject })));
  const callbacks = { onSession: vi.fn(), onLoading: vi.fn(), onError: vi.fn() };
  const sync = new OnlineGameSync(load, callbacks); instances.push(sync);
  return { sync, load, pending, ...callbacks };
}
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(10000); });
afterEach(() => { for (const sync of instances.splice(0)) sync.dispose(); vi.useRealTimers(); });

describe('Monotone version resync', () => {
  it('reloads a newer version, ignores old/equal versions and duplicates', async () => {
    const h = setup(); h.sync.confirm(snapshot(2));
    h.sync.hint(1); h.sync.hint(2); expect(h.load).not.toHaveBeenCalled();
    h.sync.hint(3); h.sync.hint(3); expect(h.load).toHaveBeenCalledTimes(1);
    h.pending[0].resolve(snapshot(3)); await flush();
    h.sync.hint(3); await vi.advanceTimersByTimeAsync(2000); expect(h.load).toHaveBeenCalledTimes(1);
    expect(h.onSession.mock.calls.map(([session]) => session.game.version)).toEqual([2, 3]);
  });
  it('coalesces a burst, and reconciles a hint received during the previous read', async () => {
    const h = setup(); h.sync.confirm(snapshot(1)); h.sync.hint(2); h.sync.hint(3); h.sync.hint(4);
    h.pending[0].resolve(snapshot(2)); await flush(); expect(h.load).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000); expect(h.load).toHaveBeenCalledTimes(2);
    h.pending[1].resolve(snapshot(4)); await flush();
    expect(h.onSession.mock.calls.at(-1)?.[0].game.version).toBe(4);
  });
  it('never rolls back a newer mutation acknowledgement with a stale read', async () => {
    const h = setup(); h.sync.request(); h.sync.confirm(snapshot(5));
    h.pending[0].resolve(snapshot(2)); await flush();
    expect(h.onSession).toHaveBeenCalledTimes(1); expect(h.onSession.mock.calls[0][0].game.version).toBe(5);
  });
  it('pauses reads during mutations, ignores cancelled replies and handles queued updates afterwards', async () => {
    const h = setup(); h.sync.request(); h.sync.pause(); expect(h.pending[0].signal.aborted).toBe(true);
    h.sync.hint(3); h.sync.confirm(snapshot(2)); h.pending[0].resolve(snapshot(1)); await flush();
    expect(h.load).toHaveBeenCalledTimes(1); h.sync.resume(); await vi.advanceTimersByTimeAsync(1000);
    expect(h.load).toHaveBeenCalledTimes(2); h.pending[1].resolve(snapshot(3)); await flush();
    expect(h.onSession.mock.calls.map(([s]) => s.game.version)).toEqual([2, 3]);
  });
  it('does not reload an own-move hint after its acknowledgement already confirmed that version', async () => {
    const h = setup(); h.sync.confirm(snapshot(2)); h.sync.pause(); h.sync.hint(3); h.sync.confirm(snapshot(3)); h.sync.resume();
    expect(h.load).not.toHaveBeenCalled();
  });
  it('does not trust an invented future version or retry it indefinitely', async () => {
    const h = setup(); h.sync.confirm(snapshot(2)); h.sync.hint(999999); h.pending[0].resolve(snapshot(2)); await flush();
    h.sync.hint(999999); await vi.advanceTimersByTimeAsync(10000); expect(h.load).toHaveBeenCalledTimes(1);
    h.sync.hint(3); expect(h.load).toHaveBeenCalledTimes(2); h.pending[1].resolve(snapshot(3)); await flush();
    expect(h.onSession.mock.calls.at(-1)?.[0].game.version).toBe(3);
  });
  it('forces resync after reconnect even when no new hint was received', async () => {
    const h = setup(); h.sync.confirm(snapshot(2)); h.sync.request(); h.pending[0].resolve(snapshot(4)); await flush();
    expect(h.onSession.mock.calls.at(-1)?.[0].game.version).toBe(4);
  });
  it('cleans timers/in-flight reads and ignores all late replies after disposal', async () => {
    const h = setup(); h.sync.request(); h.sync.hint(2); h.sync.dispose(); h.pending[0].resolve(snapshot(2)); await flush();
    h.sync.hint(3); h.sync.request(); await vi.advanceTimersByTimeAsync(30000);
    expect(h.load).toHaveBeenCalledTimes(1); expect(h.onSession).not.toHaveBeenCalled();
  });
  it('reports a read error without losing the confirmed state and allows manual recovery', async () => {
    const h = setup(); h.sync.confirm(snapshot(2)); h.sync.hint(3); h.pending[0].reject(new Error('offline')); await flush();
    expect(h.onError).toHaveBeenCalledTimes(1); h.sync.request(true); h.pending[1].resolve(snapshot(3)); await flush();
    expect(h.onSession.mock.calls.at(-1)?.[0].game.version).toBe(3);
  });
});
