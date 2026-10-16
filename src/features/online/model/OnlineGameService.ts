import { restoreGame } from "../../../shared/chess/domain/serialization";
import type {
  CreatorColorChoice,
  OnlineGame,
  OnlineGameRecord,
  OnlineGameRepository,
} from "./types";
import { isGameId } from "./types";

export class OnlineGameNotFoundError extends Error {
  constructor() {
    super("Партия не найдена. Проверьте ссылку или создайте новую.");
  }
}

function restoreRecord(record: OnlineGameRecord): OnlineGame {
  const position = restoreGame(record.state).snapshot();
  return {
    ...record,
    secondPlayerColor: record.creatorColor === "w" ? "b" : "w",
    position,
    status: position.result
      ? "finished"
      : position.history.length
        ? "in-progress"
        : "waiting",
  };
}

export class OnlineGameService {
  constructor(private readonly repository: OnlineGameRepository) {}

  async createGame(
    choice: CreatorColorChoice,
    signal?: AbortSignal,
  ): Promise<OnlineGame> {
    return restoreRecord(await this.repository.createGame(choice, signal));
  }

  async loadGame(id: string, signal?: AbortSignal): Promise<OnlineGame> {
    if (!isGameId(id)) throw new OnlineGameNotFoundError();
    const record = await this.repository.getGame(id, signal);
    if (!record) throw new OnlineGameNotFoundError();
    if (record.id.toLowerCase() !== id.toLowerCase())
      throw new Error("Хранилище вернуло другую партию.");
    return restoreRecord(record);
  }
}
