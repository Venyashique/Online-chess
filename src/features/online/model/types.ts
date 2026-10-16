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
