import { createClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import type { Database } from "../../../shared/lib/supabase/database.types";
import { createBrowserSupabaseClient } from "../../../shared/lib/supabase/client";
import {
  databaseRow,
  existingGameId,
  unknownGameId,
} from "../../../test/onlineFixtures";
import {
  parseOnlineGameRecord,
  SupabaseOnlineGameRepository,
} from "./SupabaseOnlineGameRepository";

function setup(body: unknown, status = 200) {
  const fetch = vi.fn(
    async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
  );
  const client = createClient<Database>(
    "https://online-chess.test",
    "test-public-anon-key",
    {
      global: { fetch },
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
    },
  );
  return { repository: new SupabaseOnlineGameRepository(client), fetch };
}

describe("Supabase repository using real SDK and mocked HTTP", () => {
  it("creates through RPC rather than direct table access", async () => {
    const h = setup(databaseRow());
    const game = await h.repository.createGame("white");
    expect(game.id).toBe(existingGameId);
    const [url, options] = h.fetch.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(String(url)).toContain("/rest/v1/rpc/create_online_game");
    expect(options.method).toBe("POST");
    expect(JSON.parse(String(options.body))).toEqual({
      p_color_choice: "white",
    });
  });

  it("loads by ID through RPC and handles a missing record", async () => {
    const h = setup(databaseRow());
    expect((await h.repository.getGame(existingGameId))?.id).toBe(
      existingGameId,
    );
    const [url, options] = h.fetch.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(String(url)).toContain("/rest/v1/rpc/get_online_game");
    expect(JSON.parse(String(options.body))).toEqual({ p_id: existingGameId });
    expect(await setup(null).repository.getGame(unknownGameId)).toBeNull();
  });

  it("does not send invalid IDs and surfaces migration errors", async () => {
    const h = setup(null);
    expect(await h.repository.getGame("bad")).toBeNull();
    expect(h.fetch).not.toHaveBeenCalled();
    await expect(
      setup(
        { code: "PGRST202", message: "function missing" },
        404,
      ).repository.createGame("white"),
    ).rejects.toThrow("migration");
  });

  it("rejects malformed records and preserves cancellation", async () => {
    expect(() =>
      parseOnlineGameRecord({ ...databaseRow(), creator_color: "b" }),
    ).toThrow();
    expect(() =>
      parseOnlineGameRecord({
        ...databaseRow(),
        moves: [{ from: "i2", to: "e4" }],
      }),
    ).toThrow();
    const controller = new AbortController();
    controller.abort();
    await expect(
      setup(databaseRow()).repository.getGame(
        existingGameId,
        controller.signal,
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  it("handles missing or invalid public configuration without breaking other modes", () => {
    expect(createBrowserSupabaseClient({})).toBeNull();
    expect(
      createBrowserSupabaseClient({
        VITE_SUPABASE_URL: "bad url",
        VITE_SUPABASE_ANON_KEY: "test",
      }),
    ).toBeNull();
    expect(
      createBrowserSupabaseClient({
        VITE_SUPABASE_URL: "https://online-chess.test",
        VITE_SUPABASE_ANON_KEY: "test-public-anon-key",
      }),
    ).not.toBeNull();
  });
});
