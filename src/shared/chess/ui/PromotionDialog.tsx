import "./promotion.css";
import { useEffect, useRef } from "react";
import type { Color, Promotion } from "../domain/types";
import { defaultBoardTheme } from "./theme";
import type { BoardTheme } from "./theme";

const names = { q: "Ферзь", r: "Ладья", b: "Слон", n: "Конь" };
export function PromotionDialog({
  color,
  choices,
  onChoose,
  onCancel,
  theme = defaultBoardTheme,
}: {
  color: Color;
  choices: Promotion[];
  onChoose: (piece: Promotion) => void;
  onCancel: () => void;
  theme?: BoardTheme;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const PieceView = theme.PieceView;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const element = dialog.current!;
    if (element.showModal) element.showModal();
    else element.setAttribute("open", ""); // jsdom fallback
    return () => {
      if (element.close) element.close();
      previous?.focus();
    };
  }, []);
  return (
    <dialog
      ref={dialog}
      className="promotion-dialog"
      aria-labelledby="promotion-title"
      onCancel={(event) => {
        event.preventDefault();
        onCancel();
      }}
    >
      <h2 id="promotion-title">Превращение пешки</h2>
      <p>Выберите новую фигуру</p>
      <div className="promotion-options">
        {choices.map((type) => (
          <button
            type="button"
            key={type}
            onClick={() => onChoose(type)}
            aria-label={names[type]}
          >
            <PieceView type={type} color={color} />
            <span>{names[type]}</span>
          </button>
        ))}
      </div>
      <button type="button" className="text-button" onClick={onCancel}>
        Отмена
      </button>
    </dialog>
  );
}
