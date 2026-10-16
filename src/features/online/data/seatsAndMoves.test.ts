// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createOnlineTestDatabase } from "../../../test/onlineDatabase";
import { restoreGame } from "../../../shared/chess/domain/serialization";

let database: Awaited<ReturnType<typeof createOnlineTestDatabase>>;
const creator = "a".repeat(64),
  opponent = "b".repeat(64),
  outsider = "c".repeat(64);
beforeAll(async () => {
  database = await createOnlineTestDatabase();
}, 30000);
afterAll(async () => {
  await database?.db.close();
});
async function create(choice = "white") {
  const id = crypto.randomUUID();
  const response = await database.rpc("create_online_game_with_seat", {
    p_id: id,
    p_color_choice: choice,
    p_token: creator,
  });
  expect(response.code).toBe("OK");
  return response.session;
}
async function join(id: string, token = opponent) {
  return database.rpc("join_online_game", { p_id: id, p_token: token });
}
async function move(
  id: string,
  token: string,
  version: number,
  from: string,
  to: string,
  promotion?: string,
) {
  return database.handler(
    new Request("https://online-chess.test/functions/v1/submit-online-move", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        game_id: id,
        player_token: token,
        expected_version: version,
        from,
        to,
        ...(promotion ? { promotion } : {}),
      }),
    }),
  );
}

describe("4B migration + actual authoritative handler + PostgreSQL", () => {
  it.each(["white", "black", "random"])(
    "assigns creator choice %s and opposite seat, idempotent join and third rejection",
    async (choice) => {
      const created = await create(choice),
        id = created.game.id;
      expect(created.identity).toBe("recognized");
      expect(created.game.creator_color_choice).toBe(choice);
      if (choice !== "random")
        expect(created.player_color).toBe(choice === "white" ? "w" : "b");
      const joined = await join(id);
      expect(joined.code).toBe("OK");
      expect(joined.session.player_color).not.toBe(created.player_color);
      expect(joined.session.game.version).toBe(2);
      const again = await join(id);
      expect(again).toEqual(joined);
      const creatorJoin = await join(id, creator);
      expect(creatorJoin.session.player_color).toBe(created.player_color);
      expect(creatorJoin.session.game.version).toBe(2);
      expect((await join(id, outsider)).code).toBe("GAME_FULL");
    },
  );

  it("stores hashes only and never returns them in any public response", async () => {
    const created = await create(),
      id = created.game.id;
    await join(id);
    const row = (
      await database.db.query<{ creator_token_hash: Uint8Array }>(
        "select creator_token_hash from public.online_games where id=$1",
        [id],
      )
    ).rows[0];
    expect(row.creator_token_hash).toHaveLength(32);
    for (const value of [
      created,
      await database.rpc("get_online_game", { p_id: id }),
      await database.rpc("get_online_game_session", {
        p_id: id,
        p_token: creator,
      }),
      await join(id),
    ]) {
      const json = JSON.stringify(value);
      expect(json).not.toContain(creator);
      expect(json).not.toContain(opponent);
      expect(json).not.toContain("token_hash");
    }
  });

  it("restores a role only for the matching token and protects unowned 4A rows", async () => {
    const created = await create("black"),
      id = created.game.id;
    expect(
      (
        await database.rpc("get_online_game_session", {
          p_id: id,
          p_token: creator,
        })
      ).player_color,
    ).toBe("b");
    expect(
      (
        await database.rpc("get_online_game_session", {
          p_id: id,
          p_token: outsider,
        })
      ).identity,
    ).toBe("invalid");
    const legacy = await database.rpc("get_online_game", {
      p_id: database.legacyId,
    });
    expect(legacy.creator_color).toBe("b");
    expect(legacy.legacy).toBe(true);
    expect((await join(database.legacyId)).code).toBe("LEGACY_READ_ONLY");
  });

  it("creation is idempotent and another token cannot overwrite the creator", async () => {
    const created = await create("random"),
      id = created.game.id;
    const same = await database.rpc("create_online_game_with_seat", {
      p_id: id,
      p_color_choice: "random",
      p_token: creator,
    });
    expect(same.session).toEqual(created);
    expect(
      (
        await database.rpc("create_online_game_with_seat", {
          p_id: id,
          p_color_choice: "white",
          p_token: outsider,
        })
      ).code,
    ).toBe("GAME_EXISTS");
  });

  it("persists one legal move and one revision, then the opposite side can reply", async () => {
    const created = await create(),
      id = created.game.id;
    await join(id);
    const response = await move(id, creator, 2, "e2", "e4");
    expect(response.status).toBe(200);
    const saved = await response.json();
    expect(saved.session.game.version).toBe(3);
    expect(saved.session.game.moves).toEqual([{ from: "e2", to: "e4" }]);
    const reply = await move(id, opponent, 3, "c7", "c5");
    expect(reply.status).toBe(200);
    const record = (await reply.json()).session.game;
    expect(record.version).toBe(4);
    expect(record.moves).toHaveLength(2);
    expect(
      restoreGame({ initialFen: record.initial_fen, moves: record.moves })
        .snapshot()
        .history.map((m) => m.san),
    ).toEqual(["e4", "c5"]);
  });

  it("refuses wrong side, unknown token, wrong turn and illegal moves on the trusted side", async () => {
    const created = await create(),
      id = created.game.id;
    expect((await (await move(id, creator, 1, "e2", "e4")).json()).code).toBe(
      "NOT_READY",
    );
    await join(id);
    for (const [token, from, to, code] of [
      [opponent, "e7", "e5", "NOT_YOUR_TURN"],
      [outsider, "e2", "e4", "INVALID_TOKEN"],
      [creator, "e7", "e5", "INVALID_MOVE"],
      [creator, "e2", "e5", "INVALID_MOVE"],
    ]) {
      const response = await move(id, token, 2, from, to);
      expect(response.status).not.toBe(200);
      expect((await response.json()).code).toBe(code);
    }
    const row = await database.rpc("get_online_game", { p_id: id });
    expect(row.version).toBe(2);
    expect(row.moves).toEqual([]);
  });

  it("rejects stale versions, including a race between validation and commit", async () => {
    const created = await create(),
      id = created.game.id;
    await join(id);
    const [a, b] = await Promise.all([
      move(id, creator, 2, "e2", "e4"),
      move(id, creator, 2, "d2", "d4"),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const replies = await Promise.all([a.json(), b.json()]);
    expect(replies.find((r) => r.code !== "OK").code).toBe("VERSION_CONFLICT");
    const record = await database.rpc("get_online_game", { p_id: id });
    expect(record.moves).toHaveLength(1);
    expect(record.version).toBe(3);
  });

  it("prevents anon/authenticated callers from bypassing the handler or updating the table", async () => {
    const created = await create(),
      id = created.game.id;
    await join(id);
    for (const role of ["anon", "authenticated"] as const) {
      await expect(
        database.rpc(
          "commit_online_move",
          {
            p_id: id,
            p_token: creator,
            p_expected_version: 2,
            p_from: "e2",
            p_to: "e5",
          },
          role,
        ),
      ).rejects.toMatchObject({ code: "42501" });
      await expect(
        database.db.transaction(async (tx) => {
          await tx.exec(`set local role ${role}`);
          await tx.query(
            "update public.online_games set moves=$1::jsonb where id=$2",
            ["[]", id],
          );
        }),
      ).rejects.toMatchObject({ code: "42501" });
    }
  });

  it("handles promotion and terminal positions in the authoritative core", async () => {
    const created = await create(),
      id = created.game.id;
    await join(id);
    await database.db.query(
      "update public.online_games set initial_fen='7k/P7/8/8/8/8/8/7K w - - 0 1' where id=$1",
      [id],
    );
    expect((await (await move(id, creator, 2, "a7", "a8")).json()).code).toBe(
      "INVALID_MOVE",
    );
    const promoted = await move(id, creator, 2, "a7", "a8", "n");
    expect(promoted.status).toBe(200);
    // K+N vs K ends by insufficient material; no further move may be recorded.
    expect((await (await move(id, opponent, 3, "h8", "g8")).json()).code).toBe(
      "GAME_OVER",
    );
  });

  it("refuses client-supplied FEN and oversized or malformed requests", async () => {
    const created = await create();
    await join(created.game.id);
    for (const body of [
      {
        game_id: created.game.id,
        player_token: creator,
        expected_version: 2,
        from: "e2",
        to: "e4",
        fen: "fake",
      },
      "x".repeat(5000),
    ]) {
      const response = await database.handler(
        new Request("https://online-chess.test", {
          method: "POST",
          body: JSON.stringify(body),
        }),
      );
      expect(response.status).toBe(400);
    }
  });
});
