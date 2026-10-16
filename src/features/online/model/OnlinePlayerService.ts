import type { MoveAction } from "../../../shared/chess/domain/types";
import type { PlayerIdentity } from "../identity/PlayerIdentityStore";
import {
  restoreOnlineRecord,
  OnlineGameNotFoundError,
} from "./OnlineGameService";
import { OnlineActionError } from "./errors";
import type {
  CreatorColorChoice,
  OnlinePlayerRepository,
  PlayerSessionRecord,
} from "./types";
import { isGameId } from "./types";

export function restorePlayerSession(session: PlayerSessionRecord, id: string) {
  if (session.game.id.toLowerCase() !== id.toLowerCase())
    throw new Error("Хранилище вернуло другую партию.");
  return {
    game: restoreOnlineRecord(session.game),
    playerColor: session.playerColor,
    identity: session.identity,
    identityNotice: "",
  };
}
export type OnlinePlayerSession = ReturnType<typeof restorePlayerSession>;

export class OnlinePlayerService {
  constructor(
    private readonly repository: OnlinePlayerRepository,
    private readonly identity: PlayerIdentity,
  ) {}
  async createGame(choice: CreatorColorChoice, signal?: AbortSignal) {
    const id = crypto.randomUUID();
    const token = this.identity.ensure(id); // Persist before requesting the seat.
    return restorePlayerSession(
      await this.repository.createWithSeat(id, choice, token, signal),
      id,
    );
  }
  async loadGame(
    id: string,
    signal?: AbortSignal,
  ): Promise<OnlinePlayerSession> {
    if (!isGameId(id)) throw new OnlineGameNotFoundError();
    const stored = this.identity.read(id);
    const session = await this.repository.loadSession(id, stored.token, signal);
    if (!session) throw new OnlineGameNotFoundError();
    const restored = restorePlayerSession(session, id);
    if (session.identity === "invalid") this.identity.clear(id);
    restored.identityNotice =
      stored.state === "unavailable"
        ? "Хранилище браузера недоступно. Сейчас возможен только просмотр."
        : session.identity === "invalid" || stored.state === "invalid"
          ? "Некорректный ключ игрока очищен. Если место уже занято, без исходного ключа вернуться в него нельзя."
          : !session.playerColor && !session.game.seats?.legacy
            ? "В этом браузере нет ключа игрока. Можно занять свободное место; занятое место без своего ключа восстановить нельзя."
            : "";
    return restored;
  }
  async joinGame(id: string, signal?: AbortSignal) {
    if (!isGameId(id)) throw new OnlineGameNotFoundError();
    const token = this.identity.ensure(id);
    try {
      return restorePlayerSession(
        await this.repository.joinGame(id, token, signal),
        id,
      );
    } catch (error) {
      if (
        error instanceof OnlineActionError &&
        ["GAME_FULL", "LEGACY_READ_ONLY", "NOT_FOUND"].includes(error.code)
      )
        this.identity.clear(id);
      throw error;
    }
  }
  async submitMove(
    id: string,
    move: MoveAction,
    version: number,
    signal?: AbortSignal,
  ) {
    const { token } = this.identity.read(id);
    if (!token) throw new OnlineActionError("INVALID_TOKEN");
    try {
      return restorePlayerSession(
        await this.repository.submitMove(id, token, move, version, signal),
        id,
      );
    } catch (error) {
      if (error instanceof OnlineActionError && error.code === "INVALID_TOKEN")
        this.identity.clear(id);
      throw error;
    }
  }
}
