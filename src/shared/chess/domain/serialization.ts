import { ChessGame } from "./ChessGame.ts";
import type { MoveAction } from "./types.ts";

export type SerializedGame = { initialFen: string; moves: MoveAction[] };

export function serializeGame(game: ChessGame): SerializedGame {
  const snapshot = game.snapshot();
  return {
    initialFen: snapshot.initialFen,
    moves: snapshot.history.map(({ from, to, promotion }) => ({
      from,
      to,
      ...(promotion ? { promotion } : {}),
    })),
  };
}

/** Validate untrusted persisted data before replay. Keep the entire history,
 * including repetitions, instead of restoring only the last FEN. */
export function parseSerializedGame(value: unknown): SerializedGame {
  if (!value || typeof value !== "object")
    throw new Error("Некорректные данные партии.");
  const record = value as Record<string, unknown>;
  if (
    typeof record.initialFen !== "string" ||
    !record.initialFen ||
    record.initialFen.length > 128 ||
    !Array.isArray(record.moves) ||
    record.moves.length > 4096
  )
    throw new Error("Некорректные данные партии.");
  const moves: MoveAction[] = record.moves.map((raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
      throw new Error("Некорректная история ходов.");
    const move = raw as Record<string, unknown>;
    if (
      Object.keys(move).some(
        (key) => !["from", "to", "promotion"].includes(key),
      ) ||
      typeof move.from !== "string" ||
      !/^[a-h][1-8]$/.test(move.from) ||
      typeof move.to !== "string" ||
      !/^[a-h][1-8]$/.test(move.to) ||
      move.from === move.to ||
      (move.promotion !== undefined &&
        (typeof move.promotion !== "string" ||
          !/^[qrbn]$/.test(move.promotion)))
    )
      throw new Error("Некорректная история ходов.");
    return {
      from: move.from,
      to: move.to,
      ...(move.promotion ? { promotion: move.promotion } : {}),
    } as MoveAction;
  });
  return { initialFen: record.initialFen, moves };
}

export function restoreGame(value: unknown): ChessGame {
  const saved = parseSerializedGame(value);
  let game: ChessGame;
  try {
    game = new ChessGame(saved.initialFen);
  } catch {
    throw new Error(
      "В сохранённой партии указана некорректная исходная позиция.",
    );
  }
  for (const move of saved.moves)
    if (!game.move(move))
      throw new Error("Сохранённая история содержит недопустимый ход.");
  return game;
}
