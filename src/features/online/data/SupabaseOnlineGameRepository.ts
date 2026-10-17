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

export class SupabaseOnlineGameRepository
  implements OnlineGameRepository, OnlinePlayerRepository
{
  constructor(private readonly client: SupabaseClient<Database>) {}

  async createGame(_choice: CreatorColorChoice, _signal?: AbortSignal): Promise<OnlineGameRecord> {
    throw new Error("Создание без места игрока отключено. Создайте партию в онлайн-разделе.");
  }
  async getGame(id: string, signal?: AbortSignal): Promise<OnlineGameRecord | null> {
    return (await this.loadSession(id, null, signal))?.game ?? null;
  }
  private async invoke(name: string, body: Record<string, unknown>, signal?: AbortSignal) {
    const { data, error } = await this.client.functions.invoke(name, { body, signal });
    if (signal?.aborted) throw new DOMException("Операция отменена", "AbortError");
    if (error) {
      const response = error.context instanceof Response ? error.context : null;
      const payload = response ? await response.json().catch(() => null) : null;
      const status = response?.status;
      const code = status === 429 ? (payload?.code === 'CAPACITY_REACHED' ? 'CAPACITY_REACHED' : 'RATE_LIMITED') : status === 503 ? 'UNAVAILABLE' : typeof payload?.code === 'string' ? payload.code : 'UNAVAILABLE';
      const rawRetry = Number(response?.headers.get('retry-after') || payload?.retry_after);
      const retry = status === 429 || status === 503 || !response ? Math.min(86400, Math.max(1, Math.ceil(rawRetry || 5))) : undefined;
      throw new OnlineActionError(code, retry);
    }
    return data;
  }
  async createWithSeat(id: string, choice: CreatorColorChoice, token: string, signal?: AbortSignal, turnstileToken?: string) {
    return parseActionResponse(await this.invoke('online-api', { action: 'create', game_id: id, color_choice: choice, player_token: token, ...(turnstileToken ? { turnstile_token: turnstileToken } : {}) }, signal));
  }
  async loadSession(id: string, token: string | null, signal?: AbortSignal) {
    if (!isGameId(id)) return null;
    try {
      return parseActionResponse(await this.invoke('online-api', { action: 'read', game_id: id, player_token: token }, signal));
    } catch (error) {
      if (error instanceof OnlineActionError && error.code === 'NOT_FOUND') return null;
      throw error;
    }
  }
  async joinGame(id: string, token: string, signal?: AbortSignal) {
    return parseActionResponse(await this.invoke('online-api', { action: 'join', game_id: id, player_token: token }, signal));
  }
  async submitMove(id: string, token: string, move: MoveAction, version: number, signal?: AbortSignal) {
    return parseActionResponse(await this.invoke('submit-online-move', { game_id: id, player_token: token, expected_version: version, from: move.from, to: move.to, ...(move.promotion ? { promotion: move.promotion } : {}) }, signal));
  }
}
