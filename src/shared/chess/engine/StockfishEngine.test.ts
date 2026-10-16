import { afterEach, describe, expect, it, vi } from "vitest";
import { StockfishEngine, parseBestMove } from "./StockfishEngine";
import { strengths } from "./strength";
import { ChessGame } from "../domain/ChessGame";

class FakeWorker {
  commands: string[] = [];
  onmessage: Worker["onmessage"] = null;
  onerror: Worker["onerror"] = null;
  onmessageerror: Worker["onmessageerror"] = null;
  terminate = vi.fn();
  postMessage(command: string) {
    this.commands.push(command);
  }
  emit(line: string) {
    this.onmessage?.call(
      this as unknown as Worker,
      new MessageEvent("message", { data: line }),
    );
  }
}
const initialFen = new ChessGame().snapshot().fen;
function setup() {
  const workers: FakeWorker[] = [];
  const engine = new StockfishEngine(() => {
    const worker = new FakeWorker();
    workers.push(worker);
    return worker as unknown as Worker;
  });
  const signal = new AbortController();
  const promise = engine.chooseMove(
    { initialFen, moves: [{ from: "e2", to: "e4" }] },
    strengths.easy,
    signal.signal,
  );
  return { workers, engine, signal, promise };
}
function initialize(worker: FakeWorker) {
  worker.emit(
    "option name Skill Level type spin default 20 min 0 max 20\nuciok",
  ); /* raw messages can contain several lines */
}
function handshake(worker: FakeWorker) {
  worker.emit("option name Skill Level type spin default 20 min 0 max 20");
  worker.emit("uciok");
  worker.emit("readyok");
}
afterEach(() => vi.useRealTimers());

describe("Stockfish UCI adapter", () => {
  it("handshakes before search, sends full history and maps promotion", async () => {
    const h = setup();
    const worker = h.workers[0];
    expect(worker.commands).toEqual(["uci"]);
    initialize(worker);
    worker.emit("readyok");
    expect(worker.commands).toContain("setoption name Skill Level value 0");
    expect(worker.commands).toContain(`position fen ${initialFen} moves e2e4`);
    expect(worker.commands).toContain("go depth 4 movetime 150");
    worker.emit("bestmove a7a8n ponder h8g8");
    await expect(h.promise).resolves.toEqual({
      from: "a7",
      to: "a8",
      promotion: "n",
    });
    h.engine.dispose();
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });

  it("reuses one worker between completed moves with different strengths", async () => {
    const h = setup();
    handshake(h.workers[0]);
    h.workers[0].emit("bestmove e7e5");
    await h.promise;
    const next = h.engine.chooseMove(
      { initialFen, moves: [] },
      strengths.hard,
      new AbortController().signal,
    );
    expect(h.workers).toHaveLength(1);
    expect(h.workers[0].commands).toContain(
      "setoption name Skill Level value 20",
    );
    h.workers[0].emit("readyok");
    expect(h.workers[0].commands).toContain("go depth 18 movetime 1800");
    h.workers[0].emit("bestmove e2e4");
    await next;
    h.engine.dispose();
  });

  it("destroys a cancelled worker and isolates a subsequent request", async () => {
    const h = setup();
    handshake(h.workers[0]);
    const oldHandler = h.workers[0].onmessage;
    const cancelled = expect(h.promise).rejects.toMatchObject({
      name: "AbortError",
    });
    h.signal.abort();
    await cancelled;
    expect(h.workers[0].terminate).toHaveBeenCalledTimes(1);
    const next = h.engine.chooseMove(
      { initialFen, moves: [] },
      strengths.medium,
      new AbortController().signal,
    );
    handshake(h.workers[1]);
    // Real terminated workers cannot deliver events; a retained callback is also harmless.
    // The transport callback itself must be identity-guarded.
    oldHandler?.call(
      h.workers[0] as unknown as Worker,
      new MessageEvent("message", { data: "bestmove a2a3" }),
    );
    h.workers[1].emit("bestmove d2d4");
    await expect(next).resolves.toEqual({ from: "d2", to: "d4" });
    h.engine.dispose();
  });

  it("rejects a cancelled request before creating a worker", async () => {
    const make = vi.fn();
    const engine = new StockfishEngine(make);
    const controller = new AbortController();
    controller.abort();
    await expect(
      engine.chooseMove(
        { initialFen, moves: [] },
        strengths.easy,
        controller.signal,
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(make).not.toHaveBeenCalled();
  });

  it("handles worker errors and initialization timeouts", async () => {
    vi.useFakeTimers();
    const h = setup();
    const failure = expect(h.promise).rejects.toThrow(/не загрузился/);
    await vi.advanceTimersByTimeAsync(20000);
    await failure;
    expect(h.workers[0].terminate).toHaveBeenCalledTimes(1);
  });

  it("rejects worker load errors without an unhandled error event", async () => {
    const h = setup();
    const failure = expect(h.promise).rejects.toThrow(/Не удалось запустить/);
    const event = new ErrorEvent("error", { cancelable: true });
    h.workers[0].onerror?.call(h.workers[0] as unknown as Worker, event);
    await failure;
    expect(event.defaultPrevented).toBe(true);
  });

  it("times out a stalled search and terminates the worker", async () => {
    vi.useFakeTimers();
    const h = setup();
    handshake(h.workers[0]);
    const failure = expect(h.promise).rejects.toThrow(/не ответил вовремя/);
    await vi.advanceTimersByTimeAsync(10150);
    await failure;
    expect(h.workers[0].terminate).toHaveBeenCalledTimes(1);
  });

  it("refuses builds without the strength setting", async () => {
    const h = setup();
    const failure = expect(h.promise).rejects.toThrow(/Skill Level/);
    h.workers[0].emit("uciok");
    await failure;
  });

  it("rejects malformed moves and can recognize no legal move", async () => {
    expect(parseBestMove("bestmove 0000")).toBeNull();
    expect(parseBestMove("bestmove (none)")).toBeNull();
    expect(() => parseBestMove("bestmove i9a1")).toThrow();
    const h = setup();
    handshake(h.workers[0]);
    const failure = expect(h.promise).rejects.toThrow(/Некорректный/);
    h.workers[0].emit("bestmove broken");
    await failure;
  });

  it("disposes an initializing request without leaking resources", async () => {
    const h = setup();
    const cancelled = expect(h.promise).rejects.toMatchObject({
      name: "AbortError",
    });
    h.engine.dispose();
    await cancelled;
    h.engine.dispose();
    expect(h.workers[0].terminate).toHaveBeenCalledTimes(1);
  });
});
