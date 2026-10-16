import type { MoveAction } from "../domain/types";

export type EngineStrength = {
  skillLevel: number;
  depth: number;
  moveTimeMs: number;
};
export type EnginePosition = { initialFen: string; moves: MoveAction[] };

/** Decision source only: no board state mutation and no UI dependency. */
export interface ChessEngine {
  chooseMove(
    position: EnginePosition,
    strength: EngineStrength,
    signal: AbortSignal,
  ): Promise<MoveAction | null>;
  dispose(): void;
}
export type EngineFactory = () => ChessEngine;
