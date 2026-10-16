import { useEffect, useRef, useState } from "react";
import { useGameSession } from "../../../shared/chess/session/useGameSession";
import type {
  Color,
  MoveAction,
  Promotion,
} from "../../../shared/chess/domain/types";
import { createStockfishEngine } from "../../../shared/chess/engine/StockfishEngine";
import { strengths } from "../../../shared/chess/engine/strength";
import type { Difficulty } from "../../../shared/chess/engine/strength";
import type {
  ChessEngine,
  EngineFactory,
} from "../../../shared/chess/engine/types";

export type ColorChoice = "white" | "black" | "random";
type Settings = { difficulty: Difficulty; color: ColorChoice };
type ActiveGame = { id: number; playerColor: Color; difficulty: Difficulty };
type EngineState = "idle" | "thinking" | "error";
export type ComputerGameOptions = {
  engineFactory?: EngineFactory;
  random?: () => number;
  initialFen?: string;
};

/** Computer orchestration is outside the local session and every renderer. */
export function useComputerGame({
  engineFactory = createStockfishEngine,
  random = Math.random,
  initialFen,
}: ComputerGameOptions = {}) {
  const session = useGameSession("computer", initialFen);
  const { position, getPosition, applyMove, newGame: resetPosition } = session;
  const [settings, setSettings] = useState<Settings>({
    difficulty: "medium",
    color: "white",
  });
  const [active, setActive] = useState<ActiveGame | null>(null);
  const activeRef = useRef<ActiveGame | null>(null);
  const generation = useRef(0);
  const requestId = useRef(0);
  const engine = useRef<ChessEngine | null>(null);
  const search = useRef<AbortController | null>(null);
  const [engineState, setEngineState] = useState<EngineState>("idle");
  const [engineError, setEngineError] = useState("");
  const [retry, setRetry] = useState(0);

  function startGame() {
    // Invalidate synchronously, before React effects or a late promise callback.
    generation.current++;
    requestId.current++;
    search.current?.abort();
    engine.current?.dispose();
    engine.current = null;
    const playerColor =
      settings.color === "random"
        ? random() < 0.5
          ? "w"
          : "b"
        : settings.color === "white"
          ? "w"
          : "b";
    const next: ActiveGame = {
      id: generation.current,
      playerColor,
      difficulty: settings.difficulty,
    };
    activeRef.current = next;
    resetPosition(initialFen);
    setActive(next);
    setEngineState("idle");
    setEngineError("");
  }

  useEffect(
    () => () => {
      generation.current++;
      requestId.current++;
      search.current?.abort();
      engine.current?.dispose();
      engine.current = null;
    },
    [],
  );

  useEffect(() => {
    if (!active || position.result || position.turn === active.playerColor) {
      setEngineState("idle");
      return;
    }
    const controller = new AbortController();
    search.current = controller;
    const id = ++requestId.current;
    const current = () =>
      !controller.signal.aborted &&
      requestId.current === id &&
      generation.current === active.id &&
      getPosition().fen === position.fen;
    setEngineState("thinking");
    setEngineError("");
    // A factory failure is handled in the same path as a rejected search.
    Promise.resolve()
      .then(() => {
        if (!current()) return null;
        engine.current ??= engineFactory();
        return engine.current.chooseMove(
          { initialFen: position.initialFen, moves: position.history },
          strengths[active.difficulty],
          controller.signal,
        );
      })
      .then((move) => {
        if (!current()) return;
        if (!move || !applyMove(move))
          throw new Error("Движок вернул недопустимый ход. Повторите расчёт.");
        setEngineState("idle");
      })
      .catch((error: unknown) => {
        if (!current()) return;
        engine.current?.dispose();
        engine.current = null;
        setEngineState("error");
        setEngineError(
          error instanceof Error
            ? error.message
            : "Ошибка компьютерного соперника.",
        );
      });
    return () => {
      controller.abort();
      if (search.current === controller) search.current = null;
    };
  }, [active, position, retry, engineFactory, getPosition, applyMove]);

  function canHumanMove() {
    const game = activeRef.current;
    const now = getPosition();
    return !!game && !now.result && now.turn === game.playerColor;
  }
  function requestMove(action: MoveAction) {
    if (canHumanMove()) session.requestMove(action);
  }
  function promote(piece: Promotion) {
    if (canHumanMove()) session.promote(piece);
  }

  return {
    ...session,
    requestMove,
    promote,
    settings,
    setSettings,
    active,
    startGame,
    playerColor:
      active?.playerColor ?? (settings.color === "black" ? "b" : "w"),
    humanTurn:
      !!active && position.turn === active.playerColor && !position.result,
    engineState,
    engineError,
    retryEngine: () => setRetry((value) => value + 1),
  };
}
