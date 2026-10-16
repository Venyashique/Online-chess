import { restoreGame } from "../../../src/shared/chess/domain/serialization.ts";
import type { MoveAction } from "../../../src/shared/chess/domain/types.ts";

export type MoveCommand = MoveAction & {
  gameId: string;
  token: string;
  expectedVersion: number;
};
export interface MoveBackend {
  getSession(id: string, token: string): Promise<unknown>;
  commitMove(command: MoveCommand): Promise<unknown>;
}
const messages: Record<string, string> = {
  NOT_FOUND: "Партия не найдена.",
  INVALID_TOKEN: "Ключ игрока недействителен.",
  NOT_READY: "Ожидаем второго игрока.",
  VERSION_CONFLICT: "Позиция изменилась. Обновите партию и повторите ход.",
  NOT_YOUR_TURN: "Сейчас очередь соперника.",
  INVALID_MOVE: "Недопустимый шахматный ход.",
  GAME_OVER: "Партия уже завершена.",
  INVALID_REQUEST: "Некорректный запрос.",
  UNAVAILABLE:
    "Не удалось сохранить ход. Проверьте подключение и обновите партию.",
};
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "authorization, apikey, content-type, x-client-info, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
  "Cache-Control": "no-store",
  "Content-Type": "application/json",
};
const response = (status: number, code: string, session?: unknown) =>
  new Response(
    JSON.stringify(
      session
        ? { code, session }
        : { code, message: messages[code] ?? messages.INVALID_REQUEST },
    ),
    { status, headers: cors },
  );
const object = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

async function readBody(request: Request): Promise<unknown> {
  if (!request.body) throw new Error("empty");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > 4096) {
        await reader.cancel();
        throw new Error("large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return JSON.parse(new TextDecoder().decode(bytes));
}

/** Authoritative validation. No browser-provided FEN, history or role is used. */
export function createSubmitMoveHandler(backend: MoveBackend) {
  return async (request: Request): Promise<Response> => {
    if (request.method === "OPTIONS")
      return new Response(null, { status: 204, headers: cors });
    if (request.method !== "POST") return response(405, "INVALID_REQUEST");
    let body: Record<string, unknown> | null;
    try {
      body = object(await readBody(request));
    } catch {
      return response(400, "INVALID_REQUEST");
    }
    if (
      !body ||
      Object.keys(body).some(
        (k) =>
          ![
            "game_id",
            "player_token",
            "expected_version",
            "from",
            "to",
            "promotion",
          ].includes(k),
      ) ||
      typeof body.game_id !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        body.game_id,
      ) ||
      typeof body.player_token !== "string" ||
      !/^[0-9a-f]{64}$/.test(body.player_token) ||
      !Number.isSafeInteger(body.expected_version) ||
      Number(body.expected_version) < 1 ||
      typeof body.from !== "string" ||
      !/^[a-h][1-8]$/.test(body.from) ||
      typeof body.to !== "string" ||
      !/^[a-h][1-8]$/.test(body.to) ||
      (body.promotion !== undefined &&
        (typeof body.promotion !== "string" ||
          !/^[qrbn]$/.test(body.promotion)))
    )
      return response(400, "INVALID_REQUEST");
    const command: MoveCommand = {
      gameId: body.game_id,
      token: body.player_token,
      expectedVersion: Number(body.expected_version),
      from: body.from as MoveAction["from"],
      to: body.to as MoveAction["to"],
      ...(body.promotion
        ? { promotion: body.promotion as MoveAction["promotion"] }
        : {}),
    };
    try {
      const session = object(
        await backend.getSession(command.gameId, command.token),
      );
      if (!session) return response(404, "NOT_FOUND");
      const row = object(session.game);
      if (!row || row.id !== command.gameId)
        return response(503, "UNAVAILABLE");
      if (
        session.identity !== "recognized" ||
        !["w", "b"].includes(String(session.player_color))
      )
        return response(403, "INVALID_TOKEN");
      if (!row.opponent_joined_at) return response(409, "NOT_READY");
      if (row.version !== command.expectedVersion)
        return response(409, "VERSION_CONFLICT");
      const game = restoreGame({
        initialFen: row.initial_fen,
        moves: row.moves,
      });
      const position = game.snapshot();
      if (position.result) return response(409, "GAME_OVER");
      if (position.turn !== session.player_color)
        return response(403, "NOT_YOUR_TURN");
      if (
        !game.move({
          from: command.from,
          to: command.to,
          ...(command.promotion ? { promotion: command.promotion } : {}),
        })
      )
        return response(422, "INVALID_MOVE");
      const committed = object(await backend.commitMove(command));
      if (!committed || typeof committed.code !== "string")
        return response(503, "UNAVAILABLE");
      if (committed.code === "OK" && object(committed.session))
        return response(200, "OK", committed.session);
      const status =
        committed.code === "INVALID_TOKEN" || committed.code === "NOT_YOUR_TURN"
          ? 403
          : committed.code === "NOT_FOUND"
            ? 404
            : 409;
      return response(
        status,
        messages[committed.code] ? committed.code : "UNAVAILABLE",
      );
    } catch {
      return response(503, "UNAVAILABLE");
    }
  };
}
