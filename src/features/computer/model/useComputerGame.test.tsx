import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useComputerGame } from "./useComputerGame";
import { strengths } from "../../../shared/chess/engine/strength";
import type {
  ChessEngine,
  EnginePosition,
  EngineStrength,
} from "../../../shared/chess/engine/types";
import type { MoveAction } from "../../../shared/chess/domain/types";

function engineHarness() {
  const requests: {
    position: EnginePosition;
    strength: EngineStrength;
    signal: AbortSignal;
    resolve: (move: MoveAction | null) => void;
    reject: (error: Error) => void;
  }[] = [];
  const dispose = vi.fn();
  // Deliberately ignores AbortSignal: the session must still reject stale results.
  const engine: ChessEngine = {
    dispose,
    chooseMove: vi.fn(
      (
        position: EnginePosition,
        strength: EngineStrength,
        signal: AbortSignal,
      ) =>
        new Promise<MoveAction | null>((resolve, reject) => {
          requests.push({ position, strength, signal, resolve, reject });
        }),
    ),
  };
  return { requests, dispose, factory: vi.fn(() => engine) };
}

async function ready(harness: ReturnType<typeof engineHarness>, count = 1) {
  await waitFor(() => expect(harness.requests).toHaveLength(count));
}

describe("Computer session orchestration", () => {
  it("waits for start, permits only the human side and rejects a second move during search", async () => {
    const h = engineHarness();
    const { result } = renderHook(() =>
      useComputerGame({ engineFactory: h.factory }),
    );
    act(() => result.current.requestMove({ from: "e2", to: "e4" }));
    expect(result.current.position.history).toHaveLength(0);
    expect(h.factory).not.toHaveBeenCalled();
    act(() => result.current.startGame());
    act(() => result.current.requestMove({ from: "e7", to: "e5" }));
    expect(result.current.position.history).toHaveLength(0);
    act(() => result.current.requestMove({ from: "e2", to: "e4" }));
    await ready(h);
    expect(result.current.engineState).toBe("thinking");
    expect(result.current.humanTurn).toBe(false);
    expect(h.requests[0].position.moves).toMatchObject([
      { from: "e2", to: "e4" },
    ]);
    act(() => {
      result.current.requestMove({ from: "e7", to: "e5" });
      result.current.requestMove({ from: "d2", to: "d4" });
    });
    expect(result.current.position.history).toHaveLength(1);
    await act(async () => h.requests[0].resolve({ from: "e7", to: "e5" }));
    expect(result.current.position.history.map((m) => m.san)).toEqual([
      "e4",
      "e5",
    ]);
    expect(result.current.position.turn).toBe("w");
    expect(result.current.humanTurn).toBe(true);
  });

  it("starts with the computer playing white when human selects black", async () => {
    const h = engineHarness();
    const { result } = renderHook(() =>
      useComputerGame({ engineFactory: h.factory }),
    );
    act(() =>
      result.current.setSettings({ color: "black", difficulty: "medium" }),
    );
    act(() => result.current.startGame());
    await ready(h);
    expect(result.current.playerColor).toBe("b");
    expect(h.requests[0].position.moves).toEqual([]);
    await act(async () => h.requests[0].resolve({ from: "e2", to: "e4" }));
    expect(result.current.position.history[0].san).toBe("e4");
    expect(result.current.humanTurn).toBe(true);
  });

  it("invalidates a pending computation synchronously on new game", async () => {
    const h = engineHarness();
    const { result } = renderHook(() =>
      useComputerGame({ engineFactory: h.factory }),
    );
    act(() => result.current.startGame());
    act(() => result.current.requestMove({ from: "e2", to: "e4" }));
    await ready(h);
    act(() => result.current.startGame());
    expect(h.requests[0].signal.aborted).toBe(true);
    expect(h.dispose).toHaveBeenCalledTimes(1);
    await act(async () => h.requests[0].resolve({ from: "e7", to: "e5" }));
    expect(result.current.position.history).toHaveLength(0);
    expect(result.current.position.turn).toBe("w");
  });

  it("ignores a stale response even when a new game has the identical FEN", async () => {
    const h = engineHarness();
    const { result } = renderHook(() =>
      useComputerGame({ engineFactory: h.factory }),
    );
    act(() =>
      result.current.setSettings({ color: "black", difficulty: "hard" }),
    );
    act(() => result.current.startGame());
    await ready(h);
    act(() => result.current.startGame());
    await ready(h, 2);
    await act(async () => h.requests[0].resolve({ from: "e2", to: "e4" }));
    expect(result.current.position.history).toHaveLength(0);
    await act(async () => h.requests[1].resolve({ from: "d2", to: "d4" }));
    expect(result.current.position.history.map((m) => m.san)).toEqual(["d4"]);
  });

  it("aborts and releases its engine on unmount", async () => {
    const h = engineHarness();
    const { result, unmount } = renderHook(() =>
      useComputerGame({ engineFactory: h.factory }),
    );
    act(() => result.current.startGame());
    act(() => result.current.requestMove({ from: "e2", to: "e4" }));
    await ready(h);
    unmount();
    expect(h.requests[0].signal.aborted).toBe(true);
    expect(h.dispose).toHaveBeenCalledTimes(1);
    await act(async () => h.requests[0].resolve({ from: "e7", to: "e5" }));
  });

  it("routes an illegal engine move through ChessGame and offers retry", async () => {
    const h = engineHarness();
    const { result } = renderHook(() =>
      useComputerGame({ engineFactory: h.factory }),
    );
    act(() => result.current.startGame());
    act(() => result.current.requestMove({ from: "e2", to: "e4" }));
    await ready(h);
    await act(async () => h.requests[0].resolve({ from: "e7", to: "e4" }));
    expect(result.current.engineState).toBe("error");
    expect(result.current.position.history).toHaveLength(1);
    act(() => result.current.retryEngine());
    await ready(h, 2);
    await act(async () => h.requests[1].resolve({ from: "e7", to: "e5" }));
    expect(result.current.position.history).toHaveLength(2);
    expect(result.current.engineState).toBe("idle");
  });

  it("surfaces worker failures without changing position", async () => {
    const h = engineHarness();
    const { result } = renderHook(() =>
      useComputerGame({ engineFactory: h.factory }),
    );
    act(() => result.current.startGame());
    act(() => result.current.requestMove({ from: "e2", to: "e4" }));
    await ready(h);
    await act(async () => h.requests[0].reject(new Error("WASM unavailable")));
    expect(result.current.engineError).toBe("WASM unavailable");
    expect(result.current.position.history).toHaveLength(1);
  });

  it("does not request another move after the human delivers mate", async () => {
    const h = engineHarness();
    const { result } = renderHook(() =>
      useComputerGame({
        engineFactory: h.factory,
        initialFen: "7k/5Q2/5K2/8/8/8/8/8 w - - 0 1",
      }),
    );
    act(() => result.current.startGame());
    act(() => result.current.requestMove({ from: "f7", to: "g7" }));
    expect(result.current.position.result?.reason).toBe("checkmate");
    expect(h.factory).not.toHaveBeenCalled();
  });

  it.each([
    "7k/5K2/6Q1/8/8/8/8/8 b - - 0 1",
    "7k/6Q1/5K2/8/8/8/8/8 b - - 0 1",
    "7k/8/8/8/8/8/8/7K b - - 0 1",
  ])("never starts an engine for an ended position %s", (initialFen) => {
    const h = engineHarness();
    const { result } = renderHook(() =>
      useComputerGame({ engineFactory: h.factory, initialFen }),
    );
    act(() => result.current.startGame());
    expect(result.current.position.result).not.toBeNull();
    expect(h.factory).not.toHaveBeenCalled();
  });

  it.each(["easy", "medium", "hard"] as const)(
    "passes the %s strength preset",
    async (difficulty) => {
      const h = engineHarness();
      const { result } = renderHook(() =>
        useComputerGame({ engineFactory: h.factory }),
      );
      act(() => result.current.setSettings({ color: "black", difficulty }));
      act(() => result.current.startGame());
      await ready(h);
      expect(h.requests[0].strength).toEqual(strengths[difficulty]);
    },
  );

  it("keeps active settings unchanged until a new game and resolves random each time", async () => {
    const h = engineHarness();
    const random = vi.fn().mockReturnValueOnce(0.1).mockReturnValueOnce(0.9);
    const { result } = renderHook(() =>
      useComputerGame({ engineFactory: h.factory, random }),
    );
    act(() =>
      result.current.setSettings({ color: "random", difficulty: "easy" }),
    );
    act(() => result.current.startGame());
    expect(result.current.playerColor).toBe("w");
    act(() =>
      result.current.setSettings({ color: "random", difficulty: "hard" }),
    );
    expect(result.current.active?.difficulty).toBe("easy");
    act(() => result.current.startGame());
    await ready(h);
    expect(result.current.playerColor).toBe("b");
    expect(h.requests[0].strength).toEqual(strengths.hard);
    expect(random).toHaveBeenCalledTimes(2);
  });
});
