// Public chess vocabulary: renderers do not depend on chess.js or React.
export type Color = "w" | "b";
export type PieceType = "p" | "n" | "b" | "r" | "q" | "k";
export type File = "a" | "b" | "c" | "d" | "e" | "f" | "g" | "h";
export type Rank = "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8";
export type Square = `${File}${Rank}`;
export type Promotion = "q" | "r" | "b" | "n";
export type MoveAction = { from: Square; to: Square; promotion?: Promotion };
export type Piece = { square: Square; color: Color; type: PieceType };
export type PlayedMove = MoveAction & { color: Color; san: string };
export type GameResult =
  | { reason: "checkmate"; winner: Color }
  | {
      reason:
        | "stalemate"
        | "insufficient-material"
        | "repetition"
        | "fifty-moves"
        | "draw";
      winner: null;
    };
export type GameSnapshot = {
  initialFen: string;
  fen: string;
  pieces: Piece[];
  turn: Color;
  inCheck: boolean;
  checkedKing: Square | null;
  legalMoves: MoveAction[];
  history: PlayedMove[];
  lastMove: PlayedMove | null;
  result: GameResult | null;
};
