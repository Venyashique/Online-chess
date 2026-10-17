import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useOnlineGame } from '../model/useOnlineGame';
import { OnlineActionError } from '../model/errors';
import { existingGameId, onlineGameFixture, playerSessionFixture } from '../../../test/onlineFixtures';
import type { OnlinePlayerRepository } from '../model/types';
import { OnlineGameSync } from './OnlineGameSync';
import { restorePlayerSession } from '../model/OnlinePlayerService';
function setup() {
  const record = onlineGameFixture({ version: 2, seats: { legacy: false, creatorJoinedAt: '2026-10-17T00:00:00Z', opponentJoinedAt: '2026-10-17T00:00:00Z' } });
  const session = playerSessionFixture(record, 'w');
  const repository: OnlinePlayerRepository = { createGame: vi.fn(), getGame: vi.fn(), createWithSeat: vi.fn(), joinGame: vi.fn(), loadSession: vi.fn(async () => session), submitMove: vi.fn() };
  const identity = { read: () => ({ token: 'a'.repeat(64), state: 'available' as const }), ensure: () => 'a'.repeat(64), clear: vi.fn() };
  const hook = renderHook(() => useOnlineGame(repository, existingGameId, vi.fn(), identity, null));
  return { ...hook, repository, session };
}
beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });
describe('HTTP 429/503 cannot cause mutation replay or bypass read backoff', () => {
  it.each([['RATE_LIMITED', 10], ['UNAVAILABLE', 5]] as const)('preserves board and never retries a move after %s', async (code, seconds) => {
    const h = setup(); await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(h.result.current.canMove).toBe(true);
    vi.mocked(h.repository.submitMove).mockRejectedValue(new OnlineActionError(code, seconds));
    await act(async () => { h.result.current.requestMove({ from: 'e2', to: 'e4' }); });
    expect(h.result.current.game?.version).toBe(2); expect(h.result.current.cooldown).toBe(true);
    expect(h.repository.submitMove).toHaveBeenCalledTimes(1);
    await act(async () => { h.result.current.requestMove({ from: 'e2', to: 'e4' }); h.result.current.reload(); await vi.advanceTimersByTimeAsync(seconds * 1000 - 1); });
    expect(h.repository.submitMove).toHaveBeenCalledTimes(1); expect(h.repository.loadSession).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(h.repository.loadSession).toHaveBeenCalledTimes(2); expect(h.repository.submitMove).toHaveBeenCalledTimes(1); expect(h.result.current.game?.version).toBe(2);
    h.unmount();
  });
  it('manual, online and foreground requests do not defeat a server read cooldown', async () => {
    const h = setup(); await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    vi.mocked(h.repository.loadSession).mockRejectedValueOnce(new OnlineActionError('RATE_LIMITED', 7));
    await act(async () => { h.result.current.reload(); await vi.advanceTimersByTimeAsync(0); });
    expect(h.repository.loadSession).toHaveBeenCalledTimes(2);
    await act(async () => { h.result.current.reload(); window.dispatchEvent(new Event('online')); document.dispatchEvent(new Event('visibilitychange')); await vi.advanceTimersByTimeAsync(6999); });
    expect(h.repository.loadSession).toHaveBeenCalledTimes(2); expect(h.result.current.game?.version).toBe(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(h.repository.loadSession).toHaveBeenCalledTimes(3); expect(h.repository.submitMove).not.toHaveBeenCalled(); h.unmount();
  });
  it('forged Realtime hints cannot bypass Retry-After or replace confirmed state', async () => {
    const session = restorePlayerSession(playerSessionFixture(onlineGameFixture(), 'w'), existingGameId);
    const load = vi.fn().mockRejectedValueOnce(new OnlineActionError('RATE_LIMITED', 7)).mockResolvedValue(session);
    const onSession = vi.fn();
    const sync = new OnlineGameSync(load, { onSession, onLoading: vi.fn(), onError: vi.fn() });
    sync.request(); await vi.advanceTimersByTimeAsync(0);
    for (let i = 1; i <= 200; i++) sync.hint(i);
    sync.request(true); await vi.advanceTimersByTimeAsync(6999);
    expect(load).toHaveBeenCalledTimes(1); expect(onSession).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(load).toHaveBeenCalledTimes(2); expect(onSession).toHaveBeenCalledWith(session);
    sync.dispose();
  });
});

it('manual create retry reuses UUID/token after an ambiguous failure without automatic mutation', async () => {
  const { OnlinePlayerService } = await import('../model/OnlinePlayerService');
  const nextId = '22222222-2222-4222-8222-222222222222';
  const uuid = vi.spyOn(crypto, 'randomUUID').mockReturnValueOnce(existingGameId).mockReturnValueOnce(nextId);
  const session = playerSessionFixture(onlineGameFixture(), 'w');
  const repository = { createWithSeat: vi.fn().mockRejectedValueOnce(new OnlineActionError('UNAVAILABLE', 5)).mockResolvedValueOnce(session) } as unknown as OnlinePlayerRepository;
  const ensure = vi.fn(() => 'a'.repeat(64));
  const service = new OnlinePlayerService(repository, { read: vi.fn(), ensure, clear: vi.fn() });
  await expect(service.createGame('white', undefined, 'first-proof')).rejects.toMatchObject({ code: 'UNAVAILABLE' });
  await vi.advanceTimersByTimeAsync(60000); expect(repository.createWithSeat).toHaveBeenCalledTimes(1);
  await service.createGame('white', undefined, 'new-proof');
  expect(uuid).toHaveBeenCalledTimes(1); expect(ensure).toHaveBeenCalledTimes(1);
  expect(vi.mocked(repository.createWithSeat).mock.calls.map(args => args[0])).toEqual([existingGameId, existingGameId]);
  uuid.mockRestore();
});
