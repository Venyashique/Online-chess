import { afterEach, describe, expect, it, vi } from "vitest";
import { createBrowserSupabaseClient } from "./client";

afterEach(() => vi.unstubAllGlobals());

describe("Supabase URL configuration", () => {
  it.each(["", "/", "/rest/v1", "/rest/v1/"])(
    "builds correct REST, Function and WebSocket URLs from suffix %j",
    async (suffix) => {
      const fetch = vi.fn(async () => new Response("null", {
        headers: { "content-type": "application/json" },
      }));
      vi.stubGlobal("fetch", fetch);
      const client = createBrowserSupabaseClient({
        VITE_SUPABASE_URL: `  https://online-chess.test${suffix}  `,
        VITE_SUPABASE_ANON_KEY: "test-public-anon-key",
      });
      expect(client).not.toBeNull();
      await client!.rpc("get_online_game", {
        p_id: "00000000-0000-4000-8000-000000000000",
      });
      await client!.functions.invoke("submit-online-move", { body: {} });
      const urls = fetch.mock.calls.map(call => String((call as unknown[])[0]));
      expect(urls).toEqual([
        "https://online-chess.test/rest/v1/rpc/get_online_game",
        "https://online-chess.test/functions/v1/submit-online-move",
      ]);
      const socket = new URL(client!.realtime.endpointURL());
      expect(socket.protocol).toBe("wss:");
      expect(socket.host).toBe("online-chess.test");
      expect(socket.pathname).toBe("/realtime/v1/websocket");
    },
  );

  it("preserves the configured local origin and port", () => {
    const client = createBrowserSupabaseClient({
      VITE_SUPABASE_URL: "http://127.0.0.1:54321/rest/v1/",
      VITE_SUPABASE_ANON_KEY: "test-public-anon-key",
    });
    const socket = new URL(client!.realtime.endpointURL());
    expect(socket.origin).toBe("ws://127.0.0.1:54321");
    expect(socket.pathname).toBe("/realtime/v1/websocket");
  });

  it.each([
    "bad url",
    "ftp://online-chess.test/rest/v1/",
    "https://user:password@online-chess.test/rest/v1/",
    "https://online-chess.test/rest/v1/?apikey=example",
    "https://online-chess.test/rest/v1/#fragment",
    "https://online-chess.test/rest/v1/rpc/get_online_game",
    "https://online-chess.test/functions/v1",
    "https://online-chess.test/another-project",
  ])("rejects ambiguous or unsafe configuration %j", (url) => {
    expect(createBrowserSupabaseClient({
      VITE_SUPABASE_URL: url,
      VITE_SUPABASE_ANON_KEY: "test-public-anon-key",
    })).toBeNull();
  });

  it("still requires both configuration values", () => {
    expect(createBrowserSupabaseClient({})).toBeNull();
    expect(createBrowserSupabaseClient({
      VITE_SUPABASE_URL: "https://online-chess.test/rest/v1/",
      VITE_SUPABASE_ANON_KEY: "  ",
    })).toBeNull();
  });
});
