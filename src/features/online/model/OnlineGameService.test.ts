import { describe, expect, it, vi } from "vitest";
import { OnlineGameService } from "./OnlineGameService";
import {
  existingGameId,
  onlineGameFixture,
  unknownGameId,
} from "../../../test/onlineFixtures";
import type { OnlineGameRepository } from "./types";

function setup() {
  const repository: OnlineGameRepository = {
    createGame: vi.fn(async () => onlineGameFixture()),
    getGame: vi.fn(async () => onlineGameFixture()),
  };
  return { repository, service: new OnlineGameService(repository) };
}

describe("Online game service and repository contract", () => {
  it.each(["white", "black", "random"] as const)(
    "creates using the repository and preserves %s choice",
    async (choice) => {
      const h = setup();
      vi.mocked(h.repository.createGame).mockResolvedValue(
        onlineGameFixture({
          creatorColorChoice: choice,
          creatorColor: choice === "white" ? "w" : "b",
        }),
      );
      const game = await h.service.createGame(choice);
      expect(h.repository.createGame).toHaveBeenCalledWith(choice, undefined);
      expect(game.creatorColorChoice).toBe(choice);
      expect(game.creatorColor).toBe(choice === "white" ? "w" : "b");
      expect(game.secondPlayerColor).not.toBe(game.creatorColor);
      expect(game.position.pieces).toHaveLength(32);
      expect(game.status).toBe("waiting");
    },
  );

  it("loads an existing game and restores a playable core snapshot", async () => {
    const h = setup();
    const record = onlineGameFixture();
    record.state.moves = [{ from: "e2", to: "e4" }];
    vi.mocked(h.repository.getGame).mockResolvedValue(record);
    const game = await h.service.loadGame(existingGameId);
    expect(game.position.turn).toBe("b");
    expect(game.position.history[0].san).toBe("e4");
    expect(game.position.legalMoves).toContainEqual(
      expect.objectContaining({ from: "e7", to: "e5" }),
    );
    expect(game.status).toBe("in-progress");
  });

  it("restores a finished result", async () => {
    const h = setup();
    const record = onlineGameFixture();
    record.state.moves = [
      { from: "f2", to: "f3" },
      { from: "e7", to: "e5" },
      { from: "g2", to: "g4" },
      { from: "d8", to: "h4" },
    ];
    vi.mocked(h.repository.getGame).mockResolvedValue(record);
    const game = await h.service.loadGame(existingGameId);
    expect(game.status).toBe("finished");
    expect(game.position.result).toEqual({ reason: "checkmate", winner: "b" });
  });

  it("rejects an unknown ID and an invalid ID without an unnecessary request", async () => {
    const h = setup();
    vi.mocked(h.repository.getGame).mockResolvedValue(null);
    await expect(h.service.loadGame(unknownGameId)).rejects.toThrow(
      "Партия не найдена",
    );
    vi.mocked(h.repository.getGame).mockClear();
    await expect(h.service.loadGame("bad-id")).rejects.toThrow(
      "Партия не найдена",
    );
    expect(h.repository.getGame).not.toHaveBeenCalled();
  });

  it("rejects corrupted stored moves and mismatched record identity", async () => {
    const h = setup();
    vi.mocked(h.repository.getGame).mockResolvedValue(
      onlineGameFixture({ id: unknownGameId }),
    );
    await expect(h.service.loadGame(existingGameId)).rejects.toThrow(
      "другую партию",
    );
    const record = onlineGameFixture();
    record.state.moves = [{ from: "e2", to: "e5" }];
    vi.mocked(h.repository.getGame).mockResolvedValue(record);
    await expect(h.service.loadGame(existingGameId)).rejects.toThrow(
      "недопустимый ход",
    );
  });
});
