import { Chess } from "chess.js";
import type {
  GameResult,
  GameSnapshot,
  MoveAction,
  Promotion,
} from "./types.ts";

function promotionOf(piece: string | undefined): Promotion | undefined {
  return piece === "q" || piece === "r" || piece === "b" || piece === "n"
    ? piece
    : undefined;
}

/** The only adapter that knows chess.js. One instance owns one game's history. */
export class ChessGame {
  private readonly chess: Chess;
  private readonly initialFen: string;

  constructor(fen?: string) {
    this.chess = new Chess(fen);
    this.initialFen = this.chess.fen();
  }

  move(action: MoveAction): boolean {
    if (this.chess.isGameOver()) return false;
    try {
      this.chess.move(action);
      return true;
    } catch {
      // Invalid moves from any input device leave the position unchanged.
      return false;
    }
  }

  snapshot(): GameSnapshot {
    const chess = this.chess;
    const turn = chess.turn();
    let result: GameResult | null = null;
    if (chess.isCheckmate())
      result = { reason: "checkmate", winner: turn === "w" ? "b" : "w" };
    else if (chess.isStalemate())
      result = { reason: "stalemate", winner: null };
    else if (chess.isInsufficientMaterial())
      result = { reason: "insufficient-material", winner: null };
    else if (chess.isThreefoldRepetition())
      result = { reason: "repetition", winner: null };
    else if (chess.isDrawByFiftyMoves())
      result = { reason: "fifty-moves", winner: null };
    else if (chess.isDraw()) result = { reason: "draw", winner: null };

    const pieces = chess
      .board()
      .flatMap((row) =>
        row.flatMap((piece) =>
          piece
            ? [{ square: piece.square, type: piece.type, color: piece.color }]
            : [],
        ),
      );
    const history = chess.history({ verbose: true }).map((move) => ({
      from: move.from,
      to: move.to,
      promotion: promotionOf(move.promotion),
      san: move.san,
      color: move.color,
    }));
    return {
      initialFen: this.initialFen,
      fen: chess.fen(),
      pieces,
      turn,
      inCheck: chess.isCheck(),
      checkedKing: chess.isCheck()
        ? pieces.find((p) => p.type === "k" && p.color === turn)!.square
        : null,
      legalMoves: result
        ? []
        : chess.moves({ verbose: true }).map((move) => ({
            from: move.from,
            to: move.to,
            promotion: promotionOf(move.promotion),
          })),
      history,
      lastMove: history.at(-1) ?? null,
      result,
    };
  }
}
