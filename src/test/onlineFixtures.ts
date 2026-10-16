import { ChessGame } from "../shared/chess/domain/ChessGame";
import type { OnlineGameRecord } from "../features/online/model/types";

export const existingGameId = "11111111-1111-4111-8111-111111111111";
export const unknownGameId = "22222222-2222-4222-8222-222222222222";
export function onlineGameFixture(
  overrides: Partial<OnlineGameRecord> = {},
): OnlineGameRecord {
  return {
    id: existingGameId,
    createdAt: "2026-10-16T12:00:00Z",
    creatorColorChoice: "white",
    creatorColor: "w",
    version: 1,
    seats: {
      creatorJoinedAt: "2026-10-16T12:00:00Z",
      opponentJoinedAt: null,
      legacy: false,
    },
    state: { initialFen: new ChessGame().snapshot().fen, moves: [] },
    ...overrides,
  };
}
export function databaseRow(record = onlineGameFixture()) {
  return {
    id: record.id,
    created_at: record.createdAt,
    initial_fen: record.state.initialFen,
    moves: record.state.moves,
    creator_color_choice: record.creatorColorChoice,
    creator_color: record.creatorColor,
    version: record.version,
    creator_joined_at: record.seats?.creatorJoinedAt ?? null,
    opponent_joined_at: record.seats?.opponentJoinedAt ?? null,
    legacy: record.seats?.legacy ?? true,
  };
}

export function playerSessionFixture(
  game = onlineGameFixture(),
  playerColor: "w" | "b" | null = null,
): import("../features/online/model/types").PlayerSessionRecord {
  return { game, playerColor, identity: playerColor ? "recognized" : "none" };
}
