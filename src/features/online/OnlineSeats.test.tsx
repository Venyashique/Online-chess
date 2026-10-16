import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { OnlinePage } from "./OnlinePage";
import { OnlineActionError } from "./model/errors";
import type {
  OnlinePlayerRepository,
  PlayerSessionRecord,
} from "./model/types";
import {
  existingGameId,
  onlineGameFixture,
  playerSessionFixture,
} from "../../test/onlineFixtures";
import { seatStorageKey } from "./identity/PlayerIdentityStore";

const token = "a".repeat(64);
const readyGame = () =>
  onlineGameFixture({
    version: 2,
    seats: {
      creatorJoinedAt: "2026-10-16T12:00:00Z",
      opponentJoinedAt: "2026-10-16T12:01:00Z",
      legacy: false,
    },
  });
function repo(): OnlinePlayerRepository {
  return {
    createGame: vi.fn(),
    getGame: vi.fn(),
    createWithSeat: vi.fn(),
    loadSession: vi.fn(async () => playerSessionFixture(readyGame(), "w")),
    joinGame: vi.fn(),
    submitMove: vi.fn(),
  };
}
async function move(
  user: ReturnType<typeof userEvent.setup>,
  from = "e2",
  to = "e4",
) {
  await user.click(
    screen.getByRole("button", { name: new RegExp(`^${from},`) }),
  );
  await user.click(screen.getByRole("button", { name: new RegExp(`^${to},`) }));
}
beforeEach(() => {
  localStorage.clear();
  localStorage.setItem(seatStorageKey(existingGameId), token);
});

describe("Online seats and confirmed moves UI", () => {
  it("joins the opposite color and blocks the opponent turn", async () => {
    const user = userEvent.setup(),
      repository = repo();
    vi.mocked(repository.loadSession).mockResolvedValue(playerSessionFixture());
    vi.mocked(repository.joinGame).mockResolvedValue(
      playerSessionFixture(readyGame(), "b"),
    );
    render(<OnlinePage gameId={existingGameId} repository={repository} />);
    await user.click(
      await screen.findByRole("button", { name: "Занять свободный цвет" }),
    );
    expect(await screen.findByText("Вы играете чёрными")).toBeVisible();
    expect(screen.getByText("Соперник подключился")).toBeVisible();
    expect(
      screen.getByRole("button", { name: "e7, чёрные пешка" }),
    ).toBeDisabled();
    expect(repository.submitMove).not.toHaveBeenCalled();
  });
  it("waits for the second seat and reports a full game without granting a role", async () => {
    const user = userEvent.setup(),
      repository = repo();
    vi.mocked(repository.loadSession).mockResolvedValue(playerSessionFixture());
    vi.mocked(repository.joinGame).mockRejectedValue(
      new OnlineActionError("GAME_FULL"),
    );
    render(<OnlinePage gameId={existingGameId} repository={repository} />);
    expect(await screen.findByText("Ожидаем второго игрока")).toBeVisible();
    expect(
      screen.getByRole("button", { name: "e2, белые пешка" }),
    ).toBeDisabled();
    await user.click(
      screen.getByRole("button", { name: "Занять свободный цвет" }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Оба места уже заняты",
    );
    expect(localStorage.getItem(seatStorageKey(existingGameId))).toBeNull();
  });
  it("never commits optimistically, prevents duplicate submissions and uses the acknowledged state", async () => {
    const user = userEvent.setup(),
      repository = repo();
    let resolve!: (value: PlayerSessionRecord) => void;
    vi.mocked(repository.submitMove).mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    render(<OnlinePage gameId={existingGameId} repository={repository} />);
    await screen.findByText("Вы играете белыми");
    await move(user, "e7", "e5");
    expect(repository.submitMove).not.toHaveBeenCalled();
    await move(user);
    expect(repository.submitMove).toHaveBeenCalledWith(
      existingGameId,
      token,
      { from: "e2", to: "e4" },
      2,
      expect.any(AbortSignal),
    );
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "e2, белые пешка" }),
    ).toBeDisabled();
    await move(user, "d2", "d4");
    expect(repository.submitMove).toHaveBeenCalledTimes(1);
    const saved = readyGame();
    saved.state.moves = [{ from: "e2", to: "e4" }];
    saved.version = 3;
    await act(async () => resolve(playerSessionFixture(saved, "w")));
    expect(screen.getByRole("cell", { name: "e4" })).toBeVisible();
    expect(
      screen.getByRole("button", { name: "e7, чёрные пешка" }),
    ).toBeDisabled();
  });
  it("reloads after a version conflict and does not retry the mutation", async () => {
    const user = userEvent.setup(),
      repository = repo(),
      current = readyGame();
    current.state.moves = [{ from: "d2", to: "d4" }];
    current.version = 3;
    vi.mocked(repository.loadSession)
      .mockResolvedValueOnce(playerSessionFixture(readyGame(), "w"))
      .mockResolvedValue(playerSessionFixture(current, "w"));
    vi.mocked(repository.submitMove).mockRejectedValue(
      new OnlineActionError("VERSION_CONFLICT"),
    );
    render(<OnlinePage gameId={existingGameId} repository={repository} />);
    await screen.findByText("Вы играете белыми");
    await move(user);
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent("Позиция изменилась"),
    );
    expect(
      screen.getByRole("button", { name: "d4, белые пешка" }),
    ).toBeVisible();
    expect(repository.loadSession).toHaveBeenCalledTimes(2);
    expect(repository.submitMove).toHaveBeenCalledTimes(1);
  });
});
