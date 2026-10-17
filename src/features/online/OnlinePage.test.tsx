import { useEffect } from 'react';
import {
  act,
  render,
  renderHook,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { OnlinePage } from "./OnlinePage";
import { useOnlineGame } from "./model/useOnlineGame";
import type {
  OnlinePlayerRepository,
  PlayerSessionRecord,
} from "./model/types";
import {
  existingGameId,
  onlineGameFixture,
  unknownGameId,
  playerSessionFixture,
} from "../../test/onlineFixtures";

beforeEach(() => {
  localStorage.clear();
  vi.spyOn(crypto, "randomUUID").mockReturnValue(existingGameId);
});
function repository(): OnlinePlayerRepository {
  return {
    createGame: vi.fn(async () => onlineGameFixture()),
    getGame: vi.fn(async () => onlineGameFixture()),
    createWithSeat: vi.fn(async () =>
      playerSessionFixture(onlineGameFixture(), "w"),
    ),
    loadSession: vi.fn(async () => playerSessionFixture()),
    joinGame: vi.fn(async () => playerSessionFixture()),
    submitMove: vi.fn(async () => playerSessionFixture()),
  };
}

describe("Online UI with repository injection", () => {
  it("creates a record with selected color and opens its ID", async () => {
    const user = userEvent.setup();
    const repo = repository();
    const onCreated = vi.fn();
    render(<OnlinePage repository={repo} onCreated={onCreated} />);
    await user.selectOptions(screen.getByLabelText("Цвет создателя"), "random");
    await user.click(screen.getByRole("button", { name: "Создать партию" }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(existingGameId));
    expect(repo.createWithSeat).toHaveBeenCalledWith(
      existingGameId,
      "random",
      expect.stringMatching(/^[0-9a-f]{64}$/),
      expect.any(AbortSignal),
      "test-challenge",
    );
  });

  it("loads and renders a saved position, history, identity and link", async () => {
    const repo = repository();
    const record = onlineGameFixture({
      creatorColorChoice: "black",
      creatorColor: "b",
    });
    record.state.moves = [{ from: "e2", to: "e4" }];
    vi.mocked(repo.loadSession).mockResolvedValue(playerSessionFixture(record));
    render(<OnlinePage repository={repo} gameId={existingGameId} />);
    expect(
      await screen.findByRole("button", { name: "e4, белые пешка" }),
    ).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent("Ход чёрных");
    expect(screen.getByRole("cell", { name: "e4" })).toBeVisible();
    expect(
      (screen.getByLabelText("Приглашение") as HTMLInputElement).value,
    ).toContain(`#/online/${existingGameId}`);
    expect(screen.getByText(existingGameId)).toBeVisible();
    const buttons = within(
      screen.getByRole("group", { name: "Шахматная доска" }),
    ).getAllByRole("button");
    expect(buttons[0]).toHaveAttribute("data-square", "h1");
  });

  it("shows loading and a useful unknown-ID error", async () => {
    const repo = repository();
    let finish!: (record: PlayerSessionRecord | null) => void;
    vi.mocked(repo.loadSession).mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    render(<OnlinePage repository={repo} gameId={unknownGameId} />);
    expect(screen.getByRole("status")).toHaveTextContent("Загружаем партию");
    await act(async () => finish(null));
    expect(screen.getByRole("alert")).toHaveTextContent("Партия не найдена");
    expect(
      screen.getByRole("link", { name: "Вернуться в онлайн-раздел" }),
    ).toHaveAttribute("href", "#/online");
  });

  it("shows missing configuration and creation failures", async () => {
    const { unmount } = render(<OnlinePage repository={null} />);
    expect(screen.getByRole("alert")).toHaveTextContent("VITE_SUPABASE_URL");
    expect(
      screen.getByRole("button", { name: "Создать партию" }),
    ).toBeDisabled();
    unmount();
    const user = userEvent.setup();
    const repo = repository();
    vi.mocked(repo.createWithSeat).mockRejectedValue(
      new Error("Нет подключения"),
    );
    render(<OnlinePage repository={repo} />);
    await user.click(screen.getByRole("button", { name: "Создать партию" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Нет подключения",
    );
    expect(
      screen.getByRole("button", { name: "Создать партию" }),
    ).toBeEnabled();
  });

  it("copies the invitation and refreshes explicitly", async () => {
    const user = userEvent.setup();
    const repo = repository();
    render(<OnlinePage repository={repo} gameId={existingGameId} />);
    await screen.findByLabelText("Приглашение");
    await user.click(screen.getByRole("button", { name: "Копировать" }));
    expect(await screen.findByText("Ссылка скопирована")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Обновить позицию" }));
    await waitFor(() => expect(repo.loadSession).toHaveBeenCalledTimes(2));
  });

  it("ignores an old response after navigating to another ID", async () => {
    const repo = repository();
    const pending: ((record: PlayerSessionRecord | null) => void)[] = [];
    vi.mocked(repo.loadSession).mockImplementation(
      () => new Promise((resolve) => pending.push(resolve)),
    );
    const { result, rerender } = renderHook(
      ({ id }) => useOnlineGame(repo, id, vi.fn()),
      { initialProps: { id: existingGameId } },
    );
    rerender({ id: unknownGameId });
    await act(async () =>
      pending[1](
        playerSessionFixture(onlineGameFixture({ id: unknownGameId })),
      ),
    );
    await act(async () => pending[0](playerSessionFixture()));
    expect(result.current.game?.id).toBe(unknownGameId);
  });

  it("aborts a pending creation on unmount and prevents duplicate submissions", async () => {
    const repo = repository();
    let resolve!: (record: PlayerSessionRecord) => void;
    const onCreated = vi.fn();
    vi.mocked(repo.createWithSeat).mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const { result, unmount } = renderHook(() =>
      useOnlineGame(repo, undefined, onCreated),
    );
    act(() => {
      void result.current.createGame("white");
      void result.current.createGame("black");
    });
    expect(repo.createWithSeat).toHaveBeenCalledTimes(1);
    const signal = vi.mocked(repo.createWithSeat).mock.calls[0][3]!;
    unmount();
    expect(signal.aborted).toBe(true);
    await act(async () => resolve(playerSessionFixture()));
    expect(onCreated).not.toHaveBeenCalled();
  });
});

vi.mock('./TurnstileChallenge', () => ({ TurnstileChallenge: ({ onToken, resetKey }: { onToken(token: string): void; resetKey: number }) => {
  useEffect(() => onToken('test-challenge'), [onToken, resetKey]); return null;
} }));
