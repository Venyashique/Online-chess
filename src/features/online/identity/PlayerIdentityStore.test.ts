import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  PlayerIdentityStore,
  generateSeatToken,
  seatStorageKey,
} from "./PlayerIdentityStore";
import { OnlinePlayerService } from "../model/OnlinePlayerService";
import type { OnlinePlayerRepository } from "../model/types";
import {
  existingGameId,
  onlineGameFixture,
  playerSessionFixture,
} from "../../../test/onlineFixtures";

beforeEach(() => localStorage.clear());
describe("Player bearer identity", () => {
  it("generates 256-bit tokens and scopes storage to game ID", () => {
    const store = new PlayerIdentityStore();
    const token = store.ensure(existingGameId);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(store.read(existingGameId).token).toBe(token);
    expect(new PlayerIdentityStore().read(existingGameId).token).toBe(token);
    expect(store.ensure("22222222-2222-4222-8222-222222222222")).not.toBe(
      token,
    );
    expect(generateSeatToken()).not.toBe(token);
  });
  it("clears corrupt local tokens and refuses to pretend persistence works", () => {
    localStorage.setItem(seatStorageKey(existingGameId), "corrupt");
    const store = new PlayerIdentityStore();
    expect(store.read(existingGameId)).toEqual({
      token: null,
      state: "invalid",
    });
    expect(localStorage.getItem(seatStorageKey(existingGameId))).toBeNull();
    const blocked = new PlayerIdentityStore(() => {
      throw new Error("blocked");
    });
    expect(blocked.read(existingGameId).state).toBe("unavailable");
    expect(() => blocked.ensure(existingGameId)).toThrow("Хранилище браузера");
  });
  it("recovers a role after reload and clears a valid-looking rejected token", async () => {
    const store = new PlayerIdentityStore();
    const token = store.ensure(existingGameId);
    const repo = {
      loadSession: vi.fn(async (_id: string, credential: string | null) =>
        playerSessionFixture(
          onlineGameFixture(),
          credential === token ? "w" : null,
        ),
      ),
    } as unknown as OnlinePlayerRepository;
    const restored = await new OnlinePlayerService(
      repo,
      new PlayerIdentityStore(),
    ).loadGame(existingGameId);
    expect(restored.playerColor).toBe("w");
    repo.loadSession = vi.fn(async () => ({
      ...playerSessionFixture(),
      identity: "invalid" as const,
    }));
    const invalid = await new OnlinePlayerService(repo, store).loadGame(
      existingGameId,
    );
    expect(invalid.playerColor).toBeNull();
    expect(store.read(existingGameId).token).toBeNull();
    expect(invalid.identityNotice).toContain("очищен");
  });
});
