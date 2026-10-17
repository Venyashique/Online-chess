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

function setup(body: unknown, status = 200, headers: Record<string, string> = {}) {
  const fetch = vi.fn(
    async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json", ...headers },
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
  it("disables legacy creation without sending a public RPC", async () => {
    const h = setup(null);
    await expect(h.repository.createGame('white')).rejects.toThrow('без места');
    expect(h.fetch).not.toHaveBeenCalled();
  });
  it("loads through the limited Edge API and handles missing games", async () => {
    const h = setup({ code: 'OK', session: { game: databaseRow(), player_color: null, identity: 'none' } });
    expect((await h.repository.getGame(existingGameId))?.id).toBe(existingGameId);
    const [url, options] = h.fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(String(url)).toContain('/functions/v1/online-api');
    expect(JSON.parse(String(options.body))).toEqual({ action: 'read', game_id: existingGameId, player_token: null });
    expect(await setup({ code: 'NOT_FOUND' }, 404).repository.getGame(unknownGameId)).toBeNull();
  });
  it("does not send invalid IDs or expose raw backend errors", async () => {
    const h = setup(null); expect(await h.repository.getGame('bad')).toBeNull(); expect(h.fetch).not.toHaveBeenCalled();
    await expect(setup({ code: 'PGRST202', message: 'function missing' }, 404).repository.getGame(existingGameId)).rejects.toMatchObject({ code: 'PGRST202' });
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
      setup({ code: 'OK', session: { game: databaseRow(), player_color: null, identity: 'none' } }).repository.getGame(
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

it("uses a token-bearing POST for the seat and the Edge Function for moves, never a client commit RPC", async () => {
  const session = {
    game: databaseRow(),
    player_color: "w",
    identity: "recognized",
  };
  const h = setup({ code: "OK", session });
  const token = "a".repeat(64);
  await h.repository.createWithSeat(existingGameId, "white", token);
  await h.repository.submitMove(
    existingGameId,
    token,
    { from: "e2", to: "e4" },
    2,
  );
  const calls = h.fetch.mock.calls as unknown as [string, RequestInit][];
  expect(String(calls[0][0])).toContain("/functions/v1/online-api");
  expect(String(calls[1][0])).toContain("/functions/v1/submit-online-move");
  expect(String(calls[1][0])).not.toContain(token);
  expect(JSON.parse(String(calls[1][1].body))).toEqual({
    game_id: existingGameId,
    player_token: token,
    expected_version: 2,
    from: "e2",
    to: "e4",
  });
  expect(
    calls.some(([url]) => String(url).includes("commit_online_move")),
  ).toBe(false);
});

it("maps an Edge version conflict to a typed domain error", async () => {
  const h = setup({ code: "VERSION_CONFLICT", message: "stale" }, 409);
  await expect(
    h.repository.submitMove(
      existingGameId,
      "a".repeat(64),
      { from: "e2", to: "e4" },
      2,
    ),
  ).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
});

it.each([429, 503])('propagates status %i and Retry-After with a single request and no public RPC fallback', async status => {
  const h = setup({ code: status === 429 ? 'RATE_LIMITED' : 'UNAVAILABLE', retry_after: 2 }, status, { 'retry-after': '12' });
  await expect(h.repository.loadSession(existingGameId, null)).rejects.toMatchObject({ retryAfterSeconds: 12, code: status === 429 ? 'RATE_LIMITED' : 'UNAVAILABLE' });
  expect(h.fetch).toHaveBeenCalledTimes(1); expect(String((h.fetch.mock.calls as unknown as [string, RequestInit][])[0][0])).toContain('/functions/v1/online-api');
});
