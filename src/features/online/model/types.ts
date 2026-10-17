import type { Color, GameSnapshot } from "../../../shared/chess/domain/types";
import type { SerializedGame } from "../../../shared/chess/domain/serialization";

export type CreatorColorChoice = "white" | "black" | "random";
export type OnlineGameRecord = {
  id: string;
  createdAt: string;
  creatorColorChoice: CreatorColorChoice;
  creatorColor: Color;
  version: number;
  state: SerializedGame;
  seats?: {
    creatorJoinedAt: string | null;
    opponentJoinedAt: string | null;
    legacy: boolean;
  };
  updatedAt?: string;
};
export type OnlineGame = OnlineGameRecord & {
  secondPlayerColor: Color;
  position: GameSnapshot;
  status: "waiting" | "in-progress" | "finished";
};

export interface OnlineGameRepository {
  createGame(
    choice: CreatorColorChoice,
    signal?: AbortSignal,
  ): Promise<OnlineGameRecord>;
  getGame(id: string, signal?: AbortSignal): Promise<OnlineGameRecord | null>;
}

export const isGameId = (id: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);

export type PlayerSessionRecord = {
  game: OnlineGameRecord;
  playerColor: Color | null;
  identity: "recognized" | "none" | "invalid" | "legacy";
};
export interface OnlinePlayerRepository extends OnlineGameRepository {
  createWithSeat(
    id: string,
    choice: CreatorColorChoice,
    token: string,
    signal?: AbortSignal,
    turnstileToken?: string,
  ): Promise<PlayerSessionRecord>;
  loadSession(
    id: string,
    token: string | null,
    signal?: AbortSignal,
  ): Promise<PlayerSessionRecord | null>;
  joinGame(
    id: string,
    token: string,
    signal?: AbortSignal,
  ): Promise<PlayerSessionRecord>;
  submitMove(
    id: string,
    token: string,
    move: import("../../../shared/chess/domain/types").MoveAction,
    version: number,
    signal?: AbortSignal,
  ): Promise<PlayerSessionRecord>;
}
