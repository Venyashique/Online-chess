import { describe, expect, it } from "vitest";
import { ChessGame } from "./ChessGame";
import type { MoveAction } from "./types";

function play(game: ChessGame, moves: MoveAction[]) {
  for (const move of moves)
    expect(game.move(move), JSON.stringify(move)).toBe(true);
}

describe("Chess rules adapter", () => {
  it("starts with 32 pieces and allows a move, switching turns and recording SAN", () => {
    const game = new ChessGame();
    expect(game.snapshot().pieces).toHaveLength(32);
    expect(game.snapshot().legalMoves).toHaveLength(20);
    expect(game.move({ from: "e2", to: "e4" })).toBe(true);
    expect(game.snapshot()).toMatchObject({
      turn: "b",
      history: [{ san: "e4" }],
      lastMove: { from: "e2", to: "e4" },
    });
  });

  it("rejects illegal and out-of-turn moves without changing state", () => {
    const game = new ChessGame();
    const before = game.snapshot();
    expect(game.move({ from: "e2", to: "e5" })).toBe(false);
    expect(game.move({ from: "e7", to: "e5" })).toBe(false);
    expect(game.snapshot()).toEqual(before);
  });

  it("captures pieces", () => {
    const game = new ChessGame();
    play(game, [
      { from: "e2", to: "e4" },
      { from: "d7", to: "d5" },
      { from: "e4", to: "d5" },
    ]);
    expect(game.snapshot().pieces).toHaveLength(31);
    expect(game.snapshot().pieces.find((p) => p.square === "d5")).toMatchObject(
      { color: "w", type: "p" },
    );
    expect(game.snapshot().lastMove?.san).toBe("exd5");
  });

  it.each([
    ["g1", "f1"],
    ["c1", "d1"],
  ] as const)("castles to %s and moves the rook to %s", (to, rook) => {
    const game = new ChessGame("r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1");
    expect(game.move({ from: "e1", to })).toBe(true);
    expect(game.snapshot().pieces).toEqual(
      expect.arrayContaining([
        { square: to, type: "k", color: "w" },
        { square: rook, type: "r", color: "w" },
      ]),
    );
  });

  it("does not castle through an attacked square", () => {
    const game = new ChessGame("4kr2/8/8/8/8/8/8/4K2R w K - 0 1");
    expect(game.move({ from: "e1", to: "g1" })).toBe(false);
  });

  it("captures en passant and removes the bypassed pawn", () => {
    const game = new ChessGame();
    play(game, [
      { from: "e2", to: "e4" },
      { from: "a7", to: "a6" },
      { from: "e4", to: "e5" },
      { from: "d7", to: "d5" },
      { from: "e5", to: "d6" },
    ]);
    const position = game.snapshot();
    expect(position.pieces.find((p) => p.square === "d5")).toBeUndefined();
    expect(position.pieces.find((p) => p.square === "d6")).toMatchObject({
      type: "p",
      color: "w",
    });
    expect(position.pieces).toHaveLength(31);
  });

  it.each(["q", "r", "b", "n"] as const)(
    "promotes a pawn to %s",
    (promotion) => {
      const game = new ChessGame("7k/P7/8/8/8/8/8/7K w - - 0 1");
      expect(game.move({ from: "a7", to: "a8", promotion })).toBe(true);
      expect(
        game.snapshot().pieces.find((p) => p.square === "a8"),
      ).toMatchObject({ type: promotion, color: "w" });
    },
  );

  it("requires a promotion choice", () => {
    const game = new ChessGame("7k/P7/8/8/8/8/8/7K w - - 0 1");
    const fen = game.snapshot().fen;
    expect(game.move({ from: "a7", to: "a8" })).toBe(false);
    expect(game.snapshot().fen).toBe(fen);
  });

  it("reports check and rejects moves that leave the king attacked", () => {
    const game = new ChessGame("4k3/8/8/8/8/8/4R3/4K3 w - - 0 1");
    expect(game.move({ from: "e2", to: "e7" })).toBe(true);
    expect(game.snapshot()).toMatchObject({
      inCheck: true,
      checkedKing: "e8",
      result: null,
    });
    const pinned = new ChessGame("k3r3/8/8/8/8/8/4R3/4K3 w - - 0 1");
    expect(pinned.move({ from: "e2", to: "d2" })).toBe(false);
  });

  it("detects mate and blocks all further moves", () => {
    const game = new ChessGame();
    play(game, [
      { from: "f2", to: "f3" },
      { from: "e7", to: "e5" },
      { from: "g2", to: "g4" },
      { from: "d8", to: "h4" },
    ]);
    expect(game.snapshot()).toMatchObject({
      inCheck: true,
      result: { reason: "checkmate", winner: "b" },
      legalMoves: [],
    });
    const ended = game.snapshot();
    expect(game.move({ from: "a2", to: "a3" })).toBe(false);
    expect(game.snapshot()).toEqual(ended);
  });

  it("detects stalemate", () => {
    const game = new ChessGame("7k/5K2/6Q1/8/8/8/8/8 b - - 0 1");
    expect(game.snapshot()).toMatchObject({
      inCheck: false,
      result: { reason: "stalemate", winner: null },
      legalMoves: [],
    });
  });

  it("detects insufficient material", () => {
    expect(
      new ChessGame("7k/8/8/8/8/8/8/7K w - - 0 1").snapshot().result?.reason,
    ).toBe("insufficient-material");
  });

  it("retains history to detect threefold repetition", () => {
    const game = new ChessGame();
    for (let i = 0; i < 2; i++)
      play(game, [
        { from: "g1", to: "f3" },
        { from: "g8", to: "f6" },
        { from: "f3", to: "g1" },
        { from: "f6", to: "g8" },
      ]);
    expect(game.snapshot().result?.reason).toBe("repetition");
  });

  it("detects the fifty-move rule", () => {
    const game = new ChessGame("7k/8/8/8/8/8/R7/7K w - - 99 50");
    expect(game.move({ from: "a2", to: "a3" })).toBe(true);
    expect(game.snapshot().result?.reason).toBe("fifty-moves");
  });
});
