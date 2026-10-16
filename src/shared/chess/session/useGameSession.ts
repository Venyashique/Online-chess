import { useCallback, useRef, useState } from "react";
import { ChessGame } from "../domain/ChessGame";
import type { MoveAction, Promotion, Square } from "../domain/types";

export type GameMode = "computer" | "online" | "learning";
type PendingPromotion = { from: Square; to: Square; choices: Promotion[] };

/** Local rules/session primitives. This hook does not import or create an engine. */
export function useGameSession(mode: GameMode, initialFen?: string) {
  const game = useRef<ChessGame | null>(null);
  if (!game.current) game.current = new ChessGame(initialFen);
  const [position, setPosition] = useState(() => game.current!.snapshot());
  const [pendingPromotion, setPendingPromotion] =
    useState<PendingPromotion | null>(null);
  const [error, setError] = useState("");

  const getPosition = useCallback(() => game.current!.snapshot(), []);

  const applyMove = useCallback((action: MoveAction) => {
    if (!game.current!.move(action)) {
      setError("Такой ход недопустим. Выберите подсвеченную клетку.");
      return false;
    }
    setError("");
    setPendingPromotion(null);
    setPosition(game.current!.snapshot());
    return true;
  }, []);

  function requestMove(action: MoveAction) {
    if (pendingPromotion || position.result) return;
    const choices = position.legalMoves
      .filter(
        (m) => m.from === action.from && m.to === action.to && m.promotion,
      )
      .map((m) => m.promotion!);
    if (choices.length && !action.promotion) {
      setError("");
      setPendingPromotion({ from: action.from, to: action.to, choices });
      return;
    }
    applyMove(action);
  }

  function promote(promotion: Promotion) {
    if (pendingPromotion?.choices.includes(promotion))
      applyMove({ ...pendingPromotion, promotion });
  }

  const newGame = useCallback((fen?: string) => {
    game.current = new ChessGame(fen);
    setPosition(game.current.snapshot());
    setPendingPromotion(null);
    setError("");
  }, []);

  return {
    mode,
    position,
    getPosition,
    applyMove,
    requestMove,
    pendingPromotion,
    promote,
    cancelPromotion: () => setPendingPromotion(null),
    newGame,
    error,
  };
}
