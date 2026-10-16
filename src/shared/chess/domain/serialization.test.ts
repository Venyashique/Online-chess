import { describe, expect, it } from "vitest";
import { ChessGame } from "./ChessGame";
import { restoreGame, serializeGame } from "./serialization";
import type { MoveAction } from "./types";

function replay(moves: MoveAction[], fen?: string) {
  const game = new ChessGame(fen);
  for (const move of moves) expect(game.move(move)).toBe(true);
  return game;
}

describe("Canonical chess persistence", () => {
  it("round-trips initial position, next turn, SAN history and all legal moves", () => {
    const game = replay([
      { from: "e2", to: "e4" },
      { from: "c7", to: "c5" },
      { from: "g1", to: "f3" },
    ]);
    const serialized = serializeGame(game);
    expect(serialized.moves).toEqual([
      { from: "e2", to: "e4" },
      { from: "c7", to: "c5" },
      { from: "g1", to: "f3" },
    ]);
    expect(
      restoreGame(JSON.parse(JSON.stringify(serialized))).snapshot(),
    ).toEqual(game.snapshot());
    expect(restoreGame(serialized).move({ from: "b8", to: "c6" })).toBe(true);
  });

  it("restores a nonstandard initial FEN and a promotion choice", () => {
    const game = replay(
      [{ from: "a7", to: "a8", promotion: "r" }],
      "7k/P7/8/8/8/8/8/7K w - - 0 1",
    );
    expect(restoreGame(serializeGame(game)).snapshot()).toEqual(
      game.snapshot(),
    );
  });

  it("preserves en passant and castling rights", () => {
    const game = replay([
      { from: "e2", to: "e4" },
      { from: "a7", to: "a6" },
      { from: "e4", to: "e5" },
      { from: "d7", to: "d5" },
    ]);
    const restored = restoreGame(serializeGame(game));
    expect(restored.move({ from: "e5", to: "d6" })).toBe(true);
    const castle = restoreGame(
      serializeGame(new ChessGame("r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1")),
    );
    expect(castle.move({ from: "e1", to: "g1" })).toBe(true);
  });

  it("preserves mate, result and prohibition of further moves", () => {
    const game = replay([
      { from: "f2", to: "f3" },
      { from: "e7", to: "e5" },
      { from: "g2", to: "g4" },
      { from: "d8", to: "h4" },
    ]);
    const restored = restoreGame(serializeGame(game));
    expect(restored.snapshot()).toEqual(game.snapshot());
    expect(restored.move({ from: "a2", to: "a3" })).toBe(false);
  });

  it("preserves repetition detection which would be lost with current FEN alone", () => {
    const moves: MoveAction[] = [
      { from: "g1", to: "f3" },
      { from: "g8", to: "f6" },
      { from: "f3", to: "g1" },
      { from: "f6", to: "g8" },
    ];
    const game = replay([...moves, ...moves]);
    expect(restoreGame(serializeGame(game)).snapshot().result?.reason).toBe(
      "repetition",
    );
  });

  it.each([
    null,
    {},
    { initialFen: "bad fen", moves: [] },
    {
      initialFen: new ChessGame().snapshot().fen,
      moves: [{ from: "e2", to: "e5" }],
    },
    {
      initialFen: new ChessGame().snapshot().fen,
      moves: [{ from: "z2", to: "e4" }],
    },
    {
      initialFen: new ChessGame().snapshot().fen,
      moves: [{ from: "a7", to: "a8", promotion: "king" }],
    },
  ])("rejects corrupted or illegal stored data", (saved) => {
    expect(() => restoreGame(saved)).toThrow();
  });
});
