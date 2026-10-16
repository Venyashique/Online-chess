import type { ComponentType } from "react";
import type { Color, PieceType } from "../domain/types";
import { ClassicPiece } from "./ClassicPiece";

export type PieceViewProps = { type: PieceType; color: Color };
export type BoardTheme = {
  name: string;
  light: string;
  dark: string;
  selected: string;
  lastMove: string;
  legal: string;
  check: string;
  PieceView: ComponentType<PieceViewProps>;
};

export const defaultBoardTheme: BoardTheme = {
  name: "Классическая",
  light: "#eeeadd",
  dark: "#7e9677",
  selected: "#f1c763",
  lastMove: "#dcd982",
  legal: "#253d36",
  check: "#d96355",
  PieceView: ClassicPiece,
};
