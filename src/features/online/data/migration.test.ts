// @vitest-environment node
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

type Row = {
  id: string;
  created_at: string;
  initial_fen: string;
  moves: unknown[];
  creator_color_choice: string;
  creator_color: string;
  version: number;
};
const db = new PGlite();
async function asRole<T>(
  role: "anon" | "authenticated",
  operation: () => Promise<T>,
): Promise<T> {
  await db.exec(`set role ${role}`);
  try {
    return await operation();
  } finally {
    await db.exec("reset role");
  }
}
async function create(choice: string) {
  const response = await db.query<{ game: Row }>(
    "select public.create_online_game($1) as game",
    [choice],
  );
  return response.rows[0].game;
}

beforeAll(async () => {
  await db.exec("create role anon; create role authenticated;");
  await db.exec(
    readFileSync(
      new URL(
        "../../../../supabase/migrations/202610160001_online_games.sql",
        import.meta.url,
      ),
      "utf8",
    ),
  );
}, 20000);
afterAll(async () => {
  await db.close();
});

describe("Online migration and actual PostgreSQL permissions (PGlite)", () => {
  it("creates and retrieves a real record through the anon RPC", async () => {
    const game = await asRole("anon", () => create("white"));
    expect(game).toMatchObject({
      creator_color_choice: "white",
      creator_color: "w",
      moves: [],
      version: 1,
    });
    expect(game.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(game.initial_fen).toContain(" w KQkq ");
    const read = await asRole("anon", () =>
      db.query<{ game: Row }>("select public.get_online_game($1) as game", [
        game.id,
      ]),
    );
    expect(read.rows[0].game).toEqual(game);
  });

  it("persists black and resolves a random color exactly once", async () => {
    const black = await asRole("anon", () => create("black"));
    expect(black.creator_color).toBe("b");
    const random = await asRole("anon", () => create("random"));
    expect(["w", "b"]).toContain(random.creator_color);
    const again = await asRole("anon", () =>
      db.query<{ game: Row }>("select public.get_online_game($1) as game", [
        random.id,
      ]),
    );
    expect(again.rows[0].game.creator_color).toBe(random.creator_color);
    expect(random.id).not.toBe(black.id);
  });

  it("returns null for an unknown capability and rejects invalid creation parameters", async () => {
    const read = await asRole("anon", () =>
      db.query<{ game: null }>(
        "select public.get_online_game('00000000-0000-0000-0000-000000000000') as game",
      ),
    );
    expect(read.rows[0].game).toBeNull();
    await expect(asRole("anon", () => create("purple"))).rejects.toMatchObject({
      code: "22023",
    });
  });

  it.each(["anon", "authenticated"] as const)(
    "denies table listing and writes for %s",
    async (role) => {
      for (const command of [
        "select * from public.online_games",
        "insert into public.online_games default values",
        "update public.online_games set creator_color='b'",
        "delete from public.online_games",
      ]) {
        await expect(
          asRole(role, () => db.query(command)),
        ).rejects.toMatchObject({ code: "42501" });
      }
      expect((await asRole(role, () => create("white"))).creator_color).toBe(
        "w",
      );
    },
  );

  it("RLS denies rows even if SELECT is accidentally granted later", async () => {
    await db.exec("grant select on public.online_games to anon");
    try {
      const read = await asRole("anon", () =>
        db.query("select * from public.online_games"),
      );
      expect(read.rows).toEqual([]);
    } finally {
      await db.exec("revoke select on public.online_games from anon");
    }
  });

  it.each([
    "null",
    "{}",
    '[{"from":"e2","to":"e9"}]',
    '[{"from":"e2","to":"e4","san":"e4"}]',
    '[{"from":"e2","to":"e2"}]',
    '[{"from":"a7","to":"a8","promotion":"k"}]',
    '[{"from":null,"to":"e4"}]',
    '[{"from":"e2","to":"e4","promotion":null}]',
  ])("rejects malformed history %s", async (moves) => {
    await expect(
      db.query("insert into public.online_games (moves) values ($1::jsonb)", [
        moves,
      ]),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("rejects invalid color combinations and non-positive revisions", async () => {
    await expect(
      db.exec(
        "insert into public.online_games (creator_color_choice, creator_color) values ('white','b')",
      ),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      db.exec("insert into public.online_games (version) values (0)"),
    ).rejects.toMatchObject({ code: "23514" });
  });
});
