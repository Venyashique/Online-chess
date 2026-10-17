import { admit, type LimitedBackend } from '../_shared/limiter.ts';
import { object, readBody, reply, corsHeaders } from '../_shared/http.ts';
import { restoreGame } from "../../../src/shared/chess/domain/serialization.ts";
import type { MoveAction } from "../../../src/shared/chess/domain/types.ts";

export type MoveCommand = MoveAction & {
  gameId: string;
  token: string;
  expectedVersion: number;
};
export interface MoveBackend extends LimitedBackend {
  commitMove(command: MoveCommand): Promise<unknown>;
}
/** Authoritative validation. No browser-provided FEN, history or role is used. */
export function createSubmitMoveHandler(backend: MoveBackend) {
  return async (request: Request): Promise<Response> => {
    if (request.method === "OPTIONS")
      return new Response(null, { status: 204, headers: corsHeaders });
    if (request.method !== "POST") return new Response(null, { status: 405, headers: corsHeaders });
    let body: Record<string, unknown> | null;
    try {
      body = await readBody(request);
    } catch {
      return reply("INVALID_REQUEST");
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
      Number(body.expected_version) > 2147483647 ||
      typeof body.from !== "string" ||
      !/^[a-h][1-8]$/.test(body.from) ||
      typeof body.to !== "string" ||
      !/^[a-h][1-8]$/.test(body.to) ||
      (body.promotion !== undefined &&
        (typeof body.promotion !== "string" ||
          !/^[qrbn]$/.test(body.promotion)))
    )
      return reply("INVALID_REQUEST");
    const command: MoveCommand = {
      gameId: body.game_id.toLowerCase(),
      token: body.player_token,
      expectedVersion: Number(body.expected_version),
      from: body.from as MoveAction["from"],
      to: body.to as MoveAction["to"],
      ...(body.promotion
        ? { promotion: body.promotion as MoveAction["promotion"] }
        : {}),
    };
    try {
      const admission = await admit(backend, 'move', command.gameId, command.token);
      if (admission.code !== 'OK') return reply(admission.code, { ...(admission.retry_after ? { retry_after: admission.retry_after } : {}) });
      const session = object(admission.session);
      if (!session) return reply('UNAVAILABLE');
      const row = object(session.game);
      if (!row || row.id !== command.gameId)
        return reply("UNAVAILABLE");
      if (
        session.identity !== "recognized" ||
        !["w", "b"].includes(String(session.player_color))
      )
        return reply("INVALID_TOKEN");
      if (!row.opponent_joined_at) return reply("NOT_READY");
      if (row.version !== command.expectedVersion)
        return reply("VERSION_CONFLICT");
      const game = restoreGame({
        initialFen: row.initial_fen,
        moves: row.moves,
      });
      const position = game.snapshot();
      if (position.result) return reply("GAME_OVER");
      if (position.turn !== session.player_color)
        return reply("NOT_YOUR_TURN");
      if (
        !game.move({
          from: command.from,
          to: command.to,
          ...(command.promotion ? { promotion: command.promotion } : {}),
        })
      )
        return reply("INVALID_MOVE");
      const committed = object(await backend.commitMove(command));
      if (!committed || typeof committed.code !== "string")
        return reply("UNAVAILABLE");
      if (committed.code === 'OK' && !object(committed.session)) return reply('UNAVAILABLE');
      return reply(committed.code, committed.session ? { session: committed.session } : {});
    } catch {
      return reply("UNAVAILABLE");
    }
  };
}
