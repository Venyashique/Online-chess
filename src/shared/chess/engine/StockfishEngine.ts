import type { MoveAction, Promotion, Square } from "../domain/types";
import type { ChessEngine, EnginePosition, EngineStrength } from "./types";

type Job = {
  position: EnginePosition;
  strength: EngineStrength;
  stage: "uci" | "ready" | "search";
  resolve: (move: MoveAction | null) => void;
  reject: (error: Error) => void;
  cleanup: () => void;
  timer: ReturnType<typeof setTimeout>;
};

export function parseBestMove(line: string): MoveAction | null {
  const token = line.trim().split(/\s+/)[1];
  if (token === "(none)" || token === "0000") return null;
  if (!/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(token ?? ""))
    throw new Error("Некорректный ответ Stockfish.");
  return {
    from: token.slice(0, 2) as Square,
    to: token.slice(2, 4) as Square,
    ...(token[4] ? { promotion: token[4] as Promotion } : {}),
  };
}

/** One worker, one in-flight UCI search. Cancellation destroys the transport so
 * an untagged bestmove from an old search can never satisfy a new request. */
export class StockfishEngine implements ChessEngine {
  private worker: Worker | null = null;
  private initialized = false;
  private supportsSkill = false;
  private job: Job | null = null;

  constructor(
    private readonly makeWorker: () => Worker = () =>
      new Worker(
        `${import.meta.env.BASE_URL}engine/stockfish-19-lite-single.js`,
      ),
  ) {}

  chooseMove(
    position: EnginePosition,
    strength: EngineStrength,
    signal: AbortSignal,
  ): Promise<MoveAction | null> {
    if (signal.aborted)
      return Promise.reject(new DOMException("Расчёт отменён", "AbortError"));
    if (this.job)
      return Promise.reject(new Error("Движок уже рассчитывает ход."));
    return new Promise((resolve, reject) => {
      const abort = () =>
        this.fail(new DOMException("Расчёт отменён", "AbortError"));
      signal.addEventListener("abort", abort, { once: true });
      this.job = {
        position,
        strength,
        stage: this.initialized ? "ready" : "uci",
        resolve,
        reject,
        cleanup: () => signal.removeEventListener("abort", abort),
        timer: setTimeout(
          () =>
            this.fail(
              new Error(
                "Stockfish не загрузился. Проверьте поддержку WebAssembly и файлы движка.",
              ),
            ),
          20000,
        ),
      };
      try {
        if (!this.worker) {
          const worker = this.makeWorker();
          this.worker = worker;
          this.worker.onmessage = (event) => {
            if (this.worker !== worker) return;
            if (typeof event.data === "string")
              for (const line of event.data.split("\n"))
                this.receive(line.trim());
          };
          this.worker.onerror = (event) => {
            event.preventDefault();
            if (this.worker !== worker) return;
            this.fail(
              new Error(
                "Не удалось запустить Stockfish. Проверьте загрузку JS/WASM.",
              ),
            );
          };
          this.worker.onmessageerror = () => {
            if (this.worker === worker)
              this.fail(new Error("Не удалось прочитать ответ Stockfish."));
          };
        }
        if (this.initialized) this.configure();
        else this.send("uci");
      } catch (error) {
        this.fail(
          error instanceof Error
            ? error
            : new Error("Не удалось создать Worker Stockfish."),
        );
      }
    });
  }

  private send(command: string) {
    this.worker!.postMessage(command);
  }

  private configure() {
    this.job!.stage = "ready";
    this.send(
      `setoption name Skill Level value ${this.job!.strength.skillLevel}`,
    );
    this.send("setoption name Hash value 16");
    this.send("isready");
  }

  private receive(line: string) {
    const job = this.job;
    if (!job) return;
    try {
      if (job.stage === "uci") {
        if (line.startsWith("option name Skill Level type spin"))
          this.supportsSkill = true;
        if (line === "uciok") {
          if (!this.supportsSkill)
            throw new Error(
              "Эта сборка Stockfish не поддерживает Skill Level.",
            );
          this.initialized = true;
          this.send("ucinewgame");
          this.configure();
        }
      } else if (job.stage === "ready" && line === "readyok") {
        job.stage = "search";
        clearTimeout(job.timer);
        job.timer = setTimeout(
          () =>
            this.fail(
              new Error("Stockfish не ответил вовремя. Повторите расчёт."),
            ),
          job.strength.moveTimeMs + 10000,
        );
        const moves = job.position.moves
          .map((m) => `${m.from}${m.to}${m.promotion ?? ""}`)
          .join(" ");
        this.send(
          `position fen ${job.position.initialFen}${moves ? ` moves ${moves}` : ""}`,
        );
        this.send(
          `go depth ${job.strength.depth} movetime ${job.strength.moveTimeMs}`,
        );
      } else if (job.stage === "search" && line.startsWith("bestmove ")) {
        const move = parseBestMove(line);
        this.job = null;
        clearTimeout(job.timer);
        job.cleanup();
        job.resolve(move);
      }
    } catch (error) {
      this.fail(
        error instanceof Error
          ? error
          : new Error("Ошибка протокола Stockfish."),
      );
    }
  }

  private fail(error: Error) {
    const job = this.job;
    this.job = null;
    if (this.worker) {
      this.worker.onmessage = null;
      this.worker.onerror = null;
      this.worker.onmessageerror = null;
      this.worker.terminate();
    }
    this.worker = null;
    this.initialized = false;
    this.supportsSkill = false;
    if (job) {
      clearTimeout(job.timer);
      job.cleanup();
      job.reject(error);
    }
  }

  dispose() {
    this.fail(new DOMException("Движок закрыт", "AbortError"));
  }
}

export const createStockfishEngine = () => new StockfishEngine();
