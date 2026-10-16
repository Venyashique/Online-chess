import type { GameSnapshot } from "../domain/types";

export function gameStatus(position: GameSnapshot): string {
  if (position.result) {
    switch (position.result.reason) {
      case "checkmate":
        return `Мат. Победа ${position.result.winner === "w" ? "белых" : "чёрных"}.`;
      case "stalemate":
        return "Пат. Ничья.";
      case "insufficient-material":
        return "Ничья: недостаточно материала.";
      case "repetition":
        return "Ничья: троекратное повторение позиции.";
      case "fifty-moves":
        return "Ничья: правило 50 ходов.";
      case "draw":
        return "Ничья.";
    }
  }
  return `${position.inCheck ? "Шах! " : ""}Ход ${position.turn === "w" ? "белых" : "чёрных"}.`;
}
