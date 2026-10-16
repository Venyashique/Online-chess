import "./board.css";
import { useEffect, useRef, useState } from "react";
import type { CSSProperties, PointerEvent } from "react";
import type { GameSnapshot, MoveAction, Square } from "../domain/types";
import { defaultBoardTheme } from "./theme";
import type { BoardTheme } from "./theme";

export type BoardProps = {
  position: GameSnapshot;
  onMove: (action: MoveAction) => void;
  disabled?: boolean;
  orientation?: "w" | "b";
  theme?: BoardTheme;
};

export const pieceNames = {
  p: "пешка",
  n: "конь",
  b: "слон",
  r: "ладья",
  q: "ферзь",
  k: "король",
};
const files = "abcdefgh";
const squares = Array.from(
  { length: 64 },
  (_, index) => `${files[index % 8]}${8 - Math.floor(index / 8)}` as Square,
);

/** Receives a snapshot and emits intent. All legal targets come from the core. */
export function Board2D({
  position,
  onMove,
  disabled = false,
  orientation = "w",
  theme = defaultBoardTheme,
}: BoardProps) {
  const [selected, setSelected] = useState<Square | null>(null);
  const [drag, setDrag] = useState<{
    from: Square;
    x: number;
    y: number;
  } | null>(null);
  const pointer = useRef<{
    from: Square;
    x: number;
    y: number;
    moved: boolean;
  } | null>(null);
  const suppressClick = useRef(false);
  const boardRef = useRef<HTMLDivElement>(null);
  const displayedSquares =
    orientation === "w" ? squares : [...squares].reverse();
  const displayedFiles =
    orientation === "w" ? [...files] : [...files].reverse();
  const displayedRanks =
    orientation === "w" ? [8, 7, 6, 5, 4, 3, 2, 1] : [1, 2, 3, 4, 5, 6, 7, 8];
  const locked = disabled || !!position.result;
  const PieceView = theme.PieceView;
  useEffect(() => {
    setSelected(null);
    setDrag(null);
    pointer.current = null;
  }, [position, disabled, orientation]);

  function choose(square: Square) {
    if (suppressClick.current) {
      suppressClick.current = false;
      return;
    }
    if (locked) return;
    if (selected === square) {
      setSelected(null);
      return;
    }
    if (
      selected &&
      position.legalMoves.some((m) => m.from === selected && m.to === square)
    ) {
      onMove({ from: selected, to: square });
      setSelected(null);
    } else if (position.legalMoves.some((m) => m.from === square))
      setSelected(square);
    else if (selected) onMove({ from: selected, to: square });
  }

  function startDrag(event: PointerEvent<HTMLButtonElement>, square: Square) {
    // Touch dragging may produce no click; never suppress the next gesture.
    suppressClick.current = false;
    if (
      locked ||
      event.button !== 0 ||
      !position.legalMoves.some((m) => m.from === square)
    )
      return;
    pointer.current = {
      from: square,
      x: event.clientX,
      y: event.clientY,
      moved: false,
    };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  }

  function moveDrag(event: PointerEvent<HTMLButtonElement>) {
    const start = pointer.current;
    if (!start) return;
    if (Math.hypot(event.clientX - start.x, event.clientY - start.y) > 8)
      start.moved = true;
    if (start.moved) {
      setSelected(start.from);
      setDrag({ from: start.from, x: event.clientX, y: event.clientY });
    }
  }

  function endDrag(event: PointerEvent<HTMLButtonElement>) {
    const start = pointer.current;
    pointer.current = null;
    setDrag(null);
    if (!start?.moved) return;
    suppressClick.current = true;
    // Pointer capture keeps events on the source; hit-test the actual destination.
    const target = document
      .elementFromPoint(event.clientX, event.clientY)
      ?.closest<HTMLElement>("[data-square]");
    if (!locked && target && boardRef.current?.contains(target)) {
      const to = target.dataset.square as Square;
      if (to !== start.from) onMove({ from: start.from, to });
    }
    setSelected(null);
  }

  const style = {
    "--board-light": theme.light,
    "--board-dark": theme.dark,
    "--board-selected": theme.selected,
    "--board-last": theme.lastMove,
    "--board-legal": theme.legal,
    "--board-check": theme.check,
  } as CSSProperties;
  const draggedPiece = position.pieces.find((p) => p.square === drag?.from);

  return (
    <div className="board-frame" style={style}>
      <div className="board-ranks" aria-hidden="true">
        {displayedRanks.map((rank) => (
          <span key={rank}>{rank}</span>
        ))}
      </div>
      <div
        className="board-squares"
        role="group"
        aria-label="Шахматная доска"
        ref={boardRef}
      >
        {displayedSquares.map((square, index) => {
          const piece = position.pieces.find((p) => p.square === square);
          const target =
            !!selected &&
            position.legalMoves.some(
              (m) => m.from === selected && m.to === square,
            );
          const last =
            position.lastMove?.from === square ||
            position.lastMove?.to === square;
          const label = `${square}, ${piece ? `${piece.color === "w" ? "белые" : "чёрные"} ${pieceNames[piece.type]}` : "пусто"}`;
          return (
            <button
              type="button"
              key={square}
              data-square={square}
              aria-label={label}
              aria-pressed={selected === square}
              disabled={locked}
              className={`board-square ${(Math.floor(index / 8) + (index % 8)) % 2 ? "dark-square" : "light-square"}${last ? " last-square" : ""}${selected === square ? " selected-square" : ""}${position.checkedKing === square ? " check-square" : ""}${target ? " legal-square" : ""}`}
              onClick={() => choose(square)}
              onPointerDown={(e) => startDrag(e, square)}
              onPointerMove={moveDrag}
              onPointerUp={endDrag}
              onPointerCancel={() => {
                pointer.current = null;
                setDrag(null);
                suppressClick.current = false;
              }}
              onLostPointerCapture={() => {
                pointer.current = null;
                setDrag(null);
              }}
              onKeyDown={(event) => {
                suppressClick.current = false;
                if (event.key === "Escape") {
                  setSelected(null);
                  pointer.current = null;
                  setDrag(null);
                }
                const offset = {
                  ArrowLeft: -1,
                  ArrowRight: 1,
                  ArrowUp: -8,
                  ArrowDown: 8,
                }[event.key];
                if (offset !== undefined) {
                  event.preventDefault();
                  const next = index + offset;
                  if (next >= 0 && next < 64)
                    boardRef.current
                      ?.querySelectorAll<HTMLButtonElement>("button")
                      [next]?.focus();
                }
              }}
            >
              {piece && (
                <span
                  className={
                    drag?.from === square
                      ? "piece-wrapper dragged-source"
                      : "piece-wrapper"
                  }
                >
                  <PieceView type={piece.type} color={piece.color} />
                </span>
              )}
              {target && (
                <span
                  className={piece ? "legal-capture" : "legal-dot"}
                  aria-hidden="true"
                />
              )}
            </button>
          );
        })}
      </div>
      <div className="board-files" aria-hidden="true">
        {displayedFiles.map((file) => (
          <span key={file}>{file}</span>
        ))}
      </div>
      {drag && draggedPiece && (
        <div
          className="drag-piece"
          style={{
            left: drag.x,
            top: drag.y,
            width: (boardRef.current?.clientWidth ?? 400) / 8,
          }}
        >
          <PieceView type={draggedPiece.type} color={draggedPiece.color} />
        </div>
      )}
    </div>
  );
}
