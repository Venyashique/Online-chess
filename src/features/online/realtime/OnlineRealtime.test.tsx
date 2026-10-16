import { act, render, renderHook, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OnlinePage } from '../OnlinePage';
import { useOnlineGame } from '../model/useOnlineGame';
import type { OnlineGameRecord, OnlinePlayerRepository } from '../model/types';
import { fakeOnlineRealtime } from '../../../test/fakeOnlineRealtime';
import { existingGameId, unknownGameId, onlineGameFixture, playerSessionFixture } from '../../../test/onlineFixtures';
import { seatStorageKey } from '../identity/PlayerIdentityStore';

function setup() {
  let record = onlineGameFixture();
  const realtime = fakeOnlineRealtime();
  const repository: OnlinePlayerRepository = { createGame: vi.fn(), getGame: vi.fn(), createWithSeat: vi.fn(), joinGame: vi.fn(), submitMove: vi.fn(), loadSession: vi.fn(async () => playerSessionFixture(structuredClone(record), 'w')) };
  return { repository, realtime, setRecord: (value: OnlineGameRecord) => { record = value; } };
}
const ready = () => onlineGameFixture({ version: 2, seats: { creatorJoinedAt: '2026-10-16T12:00:00Z', opponentJoinedAt: '2026-10-16T12:01:00Z', legacy: false } });
beforeEach(() => { localStorage.clear(); localStorage.setItem(seatStorageKey(existingGameId), 'a'.repeat(64)); });
afterEach(() => vi.useRealTimers());

describe('Realtime to safe session resync', () => {
  it('automatically sees the joined opponent and remote move/history without manual refresh', async () => {
    const user = userEvent.setup(), h = setup();
    render(<OnlinePage repository={h.repository} realtime={h.realtime.client} gameId={existingGameId} />);
    await screen.findByText('Вы играете белыми'); expect(screen.getByText('Ожидаем второго игрока')).toBeVisible();
    h.setRecord(ready()); act(() => h.realtime.version(2));
    await screen.findByText('Соперник подключился', {}, { timeout: 2500 });
    const own = ready(); own.version = 3; own.state.moves = [{ from: 'e2', to: 'e4' }];
    vi.mocked(h.repository.submitMove).mockImplementation(async () => { h.setRecord(own); h.realtime.version(3); return playerSessionFixture(own, 'w'); });
    await user.click(screen.getByRole('button', { name: 'e2, белые пешка' })); await user.click(screen.getByRole('button', { name: 'e4, пусто' }));
    await screen.findByRole('cell', { name: 'e4' });
    const remote = structuredClone(own); remote.version = 4; remote.state.moves.push({ from: 'e7', to: 'e5' }); h.setRecord(remote);
    act(() => { h.realtime.version(4); h.realtime.version(4); });
    await screen.findByRole('cell', { name: 'e5' }, { timeout: 2500 });
    expect(screen.getByRole('status')).toHaveTextContent('Ход белых'); expect(h.repository.submitMove).toHaveBeenCalledTimes(1);
    expect(h.repository.loadSession).toHaveBeenCalledTimes(3);
  });
  it('reconnect reloads missed versions and a transport error does not destroy the game', async () => {
    const h = setup(); h.setRecord(ready());
    render(<OnlinePage repository={h.repository} realtime={h.realtime.client} gameId={existingGameId} />);
    await screen.findByText('Вы играете белыми'); act(() => h.realtime.status('reconnecting'));
    expect(screen.getByText('Переподключение…')).toBeVisible(); expect(screen.getByRole('group', { name: 'Шахматная доска' })).toBeVisible();
    const latest = ready(); latest.version = 4; latest.state.moves = [{ from: 'e2', to: 'e4' }, { from: 'e7', to: 'e5' }]; h.setRecord(latest);
    act(() => h.realtime.status('online'));
    await screen.findByRole('cell', { name: 'e5' }, { timeout: 2500 }); expect(screen.getByText('Онлайн', { exact: true })).toBeVisible();
  });
  it('unsubscribes on game switch/unmount and ignores a late old-game event', async () => {
    const h = setup(); vi.mocked(h.repository.loadSession).mockImplementation(async id => playerSessionFixture(onlineGameFixture({ id }), 'w'));
    const { result, rerender, unmount } = renderHook(({ id }) => useOnlineGame(h.repository, id, vi.fn(), undefined, h.realtime.client), { initialProps: { id: existingGameId } });
    await waitFor(() => expect(result.current.game?.id).toBe(existingGameId));
    rerender({ id: unknownGameId }); await waitFor(() => expect(result.current.game?.id).toBe(unknownGameId));
    expect(h.realtime.subscriptions[0].unsubscribe).toHaveBeenCalledTimes(1);
    act(() => h.realtime.version(999, 0)); expect(h.repository.loadSession).toHaveBeenCalledTimes(2); expect(result.current.game?.id).toBe(unknownGameId);
    unmount(); expect(h.realtime.subscriptions[1].unsubscribe).toHaveBeenCalledTimes(1);
  });
  it('ignores equal/old events and preserves a selected piece on equal-version resync', async () => {
    const user = userEvent.setup(), h = setup(); h.setRecord(ready());
    render(<OnlinePage repository={h.repository} realtime={h.realtime.client} gameId={existingGameId} />);
    await screen.findByText('Вы играете белыми'); await user.click(screen.getByRole('button', { name: 'e2, белые пешка' }));
    act(() => { h.realtime.version(1); h.realtime.version(2); }); expect(h.repository.loadSession).toHaveBeenCalledTimes(1);
    act(() => h.realtime.status('online'));
    await waitFor(() => expect(h.repository.loadSession).toHaveBeenCalledTimes(2), { timeout: 2500 });
    expect(screen.getByRole('button', { name: 'e2, белые пешка' })).toHaveAttribute('aria-pressed', 'true');
  });
  it('resyncs when the tab returns or the network becomes available and reconciles missed signals periodically', async () => {
    vi.useFakeTimers(); const h = setup();
    const { result, unmount } = renderHook(() => useOnlineGame(h.repository, existingGameId, vi.fn(), undefined, h.realtime.client));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); }); expect(result.current.game).not.toBeNull();
    const visible = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    await act(async () => { await vi.advanceTimersByTimeAsync(30000); }); expect(h.repository.loadSession).toHaveBeenCalledTimes(1);
    visible.mockReturnValue('visible');
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); await vi.advanceTimersByTimeAsync(1000); });
    expect(h.realtime.subscriptions[0].reconnect).toHaveBeenCalled(); expect(h.repository.loadSession).toHaveBeenCalledTimes(2);
    await act(async () => { window.dispatchEvent(new Event('online')); await vi.advanceTimersByTimeAsync(1000); }); expect(h.repository.loadSession).toHaveBeenCalledTimes(3);
    await act(async () => { await vi.advanceTimersByTimeAsync(30000); }); expect(vi.mocked(h.repository.loadSession).mock.calls.length).toBeGreaterThan(3);
    unmount(); visible.mockRestore();
  });
});
