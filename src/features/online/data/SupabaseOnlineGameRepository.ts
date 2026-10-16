import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../../../shared/lib/supabase/database.types";
import { parseSerializedGame } from "../../../shared/chess/domain/serialization";
import type {
  CreatorColorChoice,
  OnlineGameRecord,
  OnlineGameRepository,
} from "../model/types";
import { isGameId } from "../model/types";

export function parseOnlineGameRecord(value: unknown): OnlineGameRecord {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Некорректная запись онлайн-партии.");
  const row = value as Record<string, unknown>;
  if (
    typeof row.id !== "string" ||
    !isGameId(row.id) ||
    typeof row.created_at !== "string" ||
    !Number.isFinite(Date.parse(row.created_at)) ||
    !["white", "black", "random"].includes(String(row.creator_color_choice)) ||
    !["w", "b"].includes(String(row.creator_color)) ||
    !Number.isSafeInteger(row.version) ||
    Number(row.version) < 1 ||
    (row.creator_color_choice === "white" && row.creator_color !== "w") ||
    (row.creator_color_choice === "black" && row.creator_color !== "b")
  )
    throw new Error("Некорректная запись онлайн-партии.");
  return {
    id: row.id,
    createdAt: row.created_at,
    version: Number(row.version),
    creatorColorChoice: row.creator_color_choice as CreatorColorChoice,
    creatorColor: row.creator_color as "w" | "b",
    state: parseSerializedGame({
      initialFen: row.initial_fen,
      moves: row.moves,
    }),
  };
}

function rpcError(code: string | undefined): Error {
  if (code === "PGRST202" || code === "42P01")
    return new Error(
      "Онлайн-хранилище не подготовлено. Примените SQL migration из supabase/migrations.",
    );
  if (code === "42501")
    return new Error(
      "Нет доступа к онлайн-хранилищу. Проверьте права RPC в migration.",
    );
  return new Error(
    "Не удалось связаться с онлайн-хранилищем. Проверьте подключение и повторите попытку.",
  );
}

export class SupabaseOnlineGameRepository implements OnlineGameRepository {
  constructor(private readonly client: SupabaseClient<Database>) {}

  async createGame(
    choice: CreatorColorChoice,
    signal?: AbortSignal,
  ): Promise<OnlineGameRecord> {
    const request = this.client.rpc("create_online_game", {
      p_color_choice: choice,
    });
    const { data, error } = await (signal
      ? request.abortSignal(signal)
      : request);
    if (signal?.aborted)
      throw new DOMException("Операция отменена", "AbortError");
    if (error) throw rpcError(error.code);
    return parseOnlineGameRecord(data);
  }

  async getGame(
    id: string,
    signal?: AbortSignal,
  ): Promise<OnlineGameRecord | null> {
    if (!isGameId(id)) return null;
    const request = this.client.rpc("get_online_game", { p_id: id });
    const { data, error } = await (signal
      ? request.abortSignal(signal)
      : request);
    if (signal?.aborted)
      throw new DOMException("Операция отменена", "AbortError");
    if (error) throw rpcError(error.code);
    return data === null ? null : parseOnlineGameRecord(data);
  }
}
