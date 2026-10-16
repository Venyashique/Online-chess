import type { PieceViewProps } from "./theme";

// Local SVG artwork keeps every piece legible without external fonts or requests.
export function ClassicPiece({ type, color }: PieceViewProps) {
  const light = color === "w";
  const shapes = {
    p: (
      <>
        <circle cx="30" cy="17" r="7" />
        <path d="M25 24h10l-2 9 6 11H21l6-11-2-9Z" />
      </>
    ),
    r: (
      <>
        <path d="M18 10h6v6h4v-6h5v6h4v-6h6v14l-6 6 2 14H22l2-14-6-6V10Z" />
        <path d="M21 24h19M24 31h13" fill="none" />
      </>
    ),
    n: (
      <>
        <path d="m20 14 9-7 4 7 9 7-3 23H19l4-13 10-8-9 4-9-3 5-10Z" />
        <path d="m22 18 6-3M24 34l10-5" fill="none" />
        <circle
          cx="30"
          cy="18"
          r="1.4"
          fill={light ? "#293c32" : "#f4f1e5"}
          stroke="none"
        />
      </>
    ),
    b: (
      <>
        <path d="M30 9c-3 5-12 10-12 17 0 5 5 9 12 9s12-4 12-9c0-7-9-12-12-17Z" />
        <path d="m32 17-6 10" fill="none" />
        <path d="m26 35-6 9h20l-6-9Z" />
        <circle cx="30" cy="7" r="2.5" />
      </>
    ),
    q: (
      <>
        <path d="m16 20 7 7 7-11 7 11 7-7-6 21H22l-6-21Z" />
        <circle cx="15" cy="17" r="3" />
        <circle cx="30" cy="12" r="3" />
        <circle cx="45" cy="17" r="3" />
        <path d="M23 35h14" fill="none" />
      </>
    ),
    k: (
      <>
        <path d="M30 6v11M25 10h10" fill="none" />
        <path d="M30 22c-9-10-17-1-12 7l6 8-3 7h18l-3-7 6-8c5-8-3-17-12-7Z" />
        <path d="M24 36h12" fill="none" />
      </>
    ),
  };
  return (
    <svg
      className="chess-piece"
      viewBox="0 0 60 60"
      aria-hidden="true"
      fill={light ? "#fff9e9" : "#293c32"}
      stroke={light ? "#3b493b" : "#e0e4d8"}
      strokeWidth="1.8"
      strokeLinejoin="round"
      strokeLinecap="round"
    >
      {shapes[type]}
      <path d="M20 44h20l4 8H16l4-8Z" />
      <path d="M18 48h24" fill="none" />
    </svg>
  );
}
