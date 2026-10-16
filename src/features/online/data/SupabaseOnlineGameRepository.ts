import { OnlineActionError } from "../model/errors";
import type { MoveAction } from "../../../shared/chess/domain/types";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../../../shared/lib/supabase/database.types";
import { parseSerializedGame } from "../../../shared/chess/domain/serialization";
import type {
  CreatorColorChoice,
  OnlineGameRecord,
  OnlineGameRepository,
  OnlinePlayerRepository,
  PlayerSessionRecord,
} from "../model/types";
import { isGameId } from "../model/types";

function nullableDate(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)))
    throw new Error("Некорректная запись онлайн-партии.");
  return value;
}
export function parsePlayerSession(value: unknown): PlayerSessionRecord {
  if (!value || typeof value !== "object")
    throw new Error("Некорректная сессия партии.");
  const row = value as Record<string, unknown>;
  if (
    !["recognized", "none", "invalid", "legacy"].includes(
      String(row.identity),
    ) ||
    !["w", "b", null].includes(row.player_color as string | null) ||
    (row.identity === "recognized") !== (row.player_color !== null)
  )
    throw new Error("Некорректная сессия партии.");
  return {
    game: parseOnlineGameRecord(row.game),
    playerColor: row.player_color as "w" | "b" | null,
    identity: row.identity as PlayerSessionRecord["identity"],
  };
}
function parseActionResponse(value: unknown): PlayerSessionRecord {
  if (!value || typeof value !== "object")
    throw new OnlineActionError("UNAVAILABLE");
  const row = value as Record<string, unknown>;
  if (row.code !== "OK")
    throw new OnlineActionError(
      typeof row.code === "string" ? row.code : "UNAVAILABLE",
    );
  return parsePlayerSession(row.session);
}
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
    seats: {
      creatorJoinedAt: nullableDate(row.creator_joined_at),
      opponentJoinedAt: nullableDate(row.opponent_joined_at),
      legacy: row.legacy !== false,
    },
    updatedAt:
      typeof row.updated_at === "string" ? row.updated_at : row.created_at,
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

export class SupabaseOnlineGameRepository
  implements OnlineGameRepository, OnlinePlayerRepository
{
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
  async createWithSeat(
    id: string,
    choice: CreatorColorChoice,
    token: string,
    signal?: AbortSignal,
  ) {
    const request = this.client.rpc("create_online_game_with_seat", {
      p_id: id,
      p_color_choice: choice,
      p_token: token,
    });
    const { data, error } = await (signal
      ? request.abortSignal(signal)
      : request);
    if (signal?.aborted)
      throw new DOMException("Операция отменена", "AbortError");
    if (error) throw rpcError(error.code);
    return parseActionResponse(data);
  }
  async loadSession(id: string, token: string | null, signal?: AbortSignal) {
    if (!isGameId(id)) return null;
    const request = this.client.rpc("get_online_game_session", {
      p_id: id,
      p_token: token,
    });
    const { data, error } = await (signal
      ? request.abortSignal(signal)
      : request);
    if (signal?.aborted)
      throw new DOMException("Операция отменена", "AbortError");
    if (error) throw rpcError(error.code);
    return data === null ? null : parsePlayerSession(data);
  }
  async joinGame(id: string, token: string, signal?: AbortSignal) {
    const request = this.client.rpc("join_online_game", {
      p_id: id,
      p_token: token,
    });
    const { data, error } = await (signal
      ? request.abortSignal(signal)
      : request);
    if (signal?.aborted)
      throw new DOMException("Операция отменена", "AbortError");
    if (error) throw rpcError(error.code);
    return parseActionResponse(data);
  }
  async submitMove(
    id: string,
    token: string,
    move: MoveAction,
    version: number,
    signal?: AbortSignal,
  ) {
    const { data, error } = await this.client.functions.invoke(
      "submit-online-move",
      {
        body: {
          game_id: id,
          player_token: token,
          expected_version: version,
          from: move.from,
          to: move.to,
          ...(move.promotion ? { promotion: move.promotion } : {}),
        },
        signal,
      },
    );
    if (signal?.aborted)
      throw new DOMException("Операция отменена", "AbortError");
    if (error) {
      if (error.context instanceof Response) {
        let body: unknown;
        try {
          body = await error.context.json();
        } catch {
          throw new OnlineActionError("UNAVAILABLE");
        }
        if (
          body &&
          typeof body === "object" &&
          "code" in body &&
          typeof body.code === "string"
        )
          throw new OnlineActionError(body.code);
      }
      throw new OnlineActionError("UNAVAILABLE");
    }
    return parseActionResponse(data);
  }
}
