import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { createSubmitMoveHandler } from "../../supabase/functions/submit-online-move/handler.ts";

export async function createOnlineTestDatabase() {
  const db = new PGlite();
  await db.exec(
    "create role anon; create role authenticated; create role service_role;",
  );
  await db.exec(
    readFileSync(
      new URL(
        "../../supabase/migrations/202610160001_online_games.sql",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  const legacy = await db.query<{ id: string }>(
    "insert into public.online_games(creator_color_choice,creator_color) values ('black','b') returning id",
  );
  await db.exec(
    readFileSync(
      new URL(
        "../../supabase/migrations/202610160002_online_seats_and_moves.sql",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  const specs: Record<string, { sql: string; keys: string[] }> = {
    create_online_game: {
      sql: "select public.create_online_game($1) as result",
      keys: ["p_color_choice"],
    },
    get_online_game: {
      sql: "select public.get_online_game($1) as result",
      keys: ["p_id"],
    },
    create_online_game_with_seat: {
      sql: "select public.create_online_game_with_seat($1,$2,$3) as result",
      keys: ["p_id", "p_color_choice", "p_token"],
    },
    get_online_game_session: {
      sql: "select public.get_online_game_session($1,$2) as result",
      keys: ["p_id", "p_token"],
    },
    join_online_game: {
      sql: "select public.join_online_game($1,$2) as result",
      keys: ["p_id", "p_token"],
    },
    commit_online_move: {
      sql: "select public.commit_online_move($1,$2,$3,$4,$5,$6) as result",
      keys: [
        "p_id",
        "p_token",
        "p_expected_version",
        "p_from",
        "p_to",
        "p_promotion",
      ],
    },
  };
  async function rpc(
    name: string,
    args: Record<string, unknown>,
    role: "anon" | "authenticated" | "service_role" = "anon",
  ): Promise<any> {
    const spec = specs[name];
    if (!spec) throw new Error("Unknown test RPC");
    return db.transaction(async (tx) => {
      await tx.exec(`set local role ${role}`);
      const response = await tx.query<{ result: unknown }>(
        spec.sql,
        spec.keys.map((key) => args[key] ?? null),
      );
      return response.rows[0].result;
    });
  }
  const handler = createSubmitMoveHandler({
    getSession: (id, token) =>
      rpc(
        "get_online_game_session",
        { p_id: id, p_token: token },
        "service_role",
      ),
    commitMove: (command) =>
      rpc(
        "commit_online_move",
        {
          p_id: command.gameId,
          p_token: command.token,
          p_expected_version: command.expectedVersion,
          p_from: command.from,
          p_to: command.to,
          p_promotion: command.promotion,
        },
        "service_role",
      ),
  });
  return { db, rpc, handler, legacyId: legacy.rows[0].id };
}
