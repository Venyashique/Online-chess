import {
  act,
  render,
  renderHook,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { OnlinePage } from "./OnlinePage";
import { useOnlineGame } from "./model/useOnlineGame";
import type { OnlineGameRecord, OnlineGameRepository } from "./model/types";
import {
  existingGameId,
  onlineGameFixture,
  unknownGameId,
} from "../../test/onlineFixtures";

function repository(): OnlineGameRepository {
  return {
    createGame: vi.fn(async () => onlineGameFixture()),
    getGame: vi.fn(async () => onlineGameFixture()),
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
    expect(repo.createGame).toHaveBeenCalledWith(
      "random",
      expect.any(AbortSignal),
    );
  });

  it("loads and renders a saved position, history, identity and link", async () => {
    const repo = repository();
    const record = onlineGameFixture({
      creatorColorChoice: "black",
      creatorColor: "b",
    });
    record.state.moves = [{ from: "e2", to: "e4" }];
    vi.mocked(repo.getGame).mockResolvedValue(record);
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
    let finish!: (record: OnlineGameRecord | null) => void;
    vi.mocked(repo.getGame).mockReturnValue(
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
    vi.mocked(repo.createGame).mockRejectedValue(new Error("Нет подключения"));
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
    await waitFor(() => expect(repo.getGame).toHaveBeenCalledTimes(2));
  });

  it("ignores an old response after navigating to another ID", async () => {
    const repo = repository();
    const pending: ((record: OnlineGameRecord | null) => void)[] = [];
    vi.mocked(repo.getGame).mockImplementation(
      () => new Promise((resolve) => pending.push(resolve)),
    );
    const { result, rerender } = renderHook(
      ({ id }) => useOnlineGame(repo, id, vi.fn()),
      { initialProps: { id: existingGameId } },
    );
    rerender({ id: unknownGameId });
    await act(async () => pending[1](onlineGameFixture({ id: unknownGameId })));
    await act(async () => pending[0](onlineGameFixture()));
    expect(result.current.game?.id).toBe(unknownGameId);
  });

  it("aborts a pending creation on unmount and prevents duplicate submissions", async () => {
    const repo = repository();
    let resolve!: (record: OnlineGameRecord) => void;
    const onCreated = vi.fn();
    vi.mocked(repo.createGame).mockImplementation(
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
    expect(repo.createGame).toHaveBeenCalledTimes(1);
    const signal = vi.mocked(repo.createGame).mock.calls[0][1]!;
    unmount();
    expect(signal.aborted).toBe(true);
    await act(async () => resolve(onlineGameFixture()));
    expect(onCreated).not.toHaveBeenCalled();
  });
});
