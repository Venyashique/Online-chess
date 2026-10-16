import type { EngineStrength } from "./types";

export type Difficulty = "easy" | "medium" | "hard";
// Stockfish's Skill Level deliberately samples weaker moves below level 20.
// These are presets, not calibrated Elo ratings (especially for the lite net).
export const strengths: Record<Difficulty, EngineStrength> = {
  easy: { skillLevel: 0, depth: 4, moveTimeMs: 150 },
  medium: { skillLevel: 8, depth: 10, moveTimeMs: 650 },
  hard: { skillLevel: 20, depth: 18, moveTimeMs: 1800 },
};
