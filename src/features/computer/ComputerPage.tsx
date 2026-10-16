import { useComputerGame } from "./model/useComputerGame";
import type { ColorChoice, ComputerGameOptions } from "./model/useComputerGame";
import type { Difficulty } from "../../shared/chess/engine/strength";
import { gameStatus } from "../../shared/chess/session/status";
import { Board2D } from "../../shared/chess/ui/Board2D";
import { PromotionDialog } from "../../shared/chess/ui/PromotionDialog";
import "./computer.css";

const difficulties: { value: Difficulty; label: string }[] = [
  { value: "easy", label: "Лёгкий" },
  { value: "medium", label: "Средний" },
  { value: "hard", label: "Сложный" },
];

export function ComputerPage(options: ComputerGameOptions = {}) {
  const session = useComputerGame(options);
  const bottomColor = session.playerColor;
  const topColor = bottomColor === "w" ? "b" : "w";
  const colorName = (color: "w" | "b") => (color === "w" ? "Белые" : "Чёрные");
  const { position } = session;
  const pairs = Array.from(
    { length: Math.ceil(position.history.length / 2) },
    (_, i) => position.history.slice(i * 2, i * 2 + 2),
  );
  return (
    <main id="main" className="game-page">
      <a className="back-link" href="#/">
        ← На главную
      </a>
      <div className="game-heading">
        <div>
          <span className="eyebrow">Пространство для практики</span>
          <h1 tabIndex={-1}>Играть с компьютером</h1>
        </div>
        <span className="stage-badge">Stockfish 19 · 2D</span>
      </div>
      <p className="game-notice">
        Выберите цвет и сложность, затем начните партию. Stockfish рассчитывает
        ходы прямо в браузере — вы играете без сервера.
      </p>
      <div className="game-layout">
        <section className="play-area" aria-label="Игровое поле">
          <div className="player-label">
            <span
              className={`player-dot ${topColor === "w" ? "white-player" : "black-player"}`}
            />{" "}
            {colorName(topColor)}
            <span>Компьютер · Stockfish</span>
          </div>
          <Board2D
            position={position}
            onMove={session.requestMove}
            disabled={!session.humanTurn || !!session.pendingPromotion}
            orientation={session.playerColor}
          />
          <div className="player-label">
            <span
              className={`player-dot ${bottomColor === "w" ? "white-player" : "black-player"}`}
            />{" "}
            {colorName(bottomColor)}
            <span>{session.active ? "Вы" : "Ваш цвет после старта"}</span>
          </div>
          <p className="board-help">
            Нажмите на фигуру и клетку назначения или перетащите фигуру. С
            клавиатуры: стрелки, Enter; Esc снимает выбор.
          </p>
        </section>
        <aside className="game-sidebar" aria-label="Информация о партии">
          <section className="game-panel">
            <span className="eyebrow">Ваша партия</span>
            <p
              className={`game-status${position.inCheck ? " status-check" : ""}`}
              role="status"
            >
              {!session.active
                ? "Готовы к первой партии?"
                : session.engineState === "error"
                  ? "Расчёт прерван"
                  : !session.humanTurn && !position.result
                    ? "Компьютер думает…"
                    : gameStatus(position)}
            </p>
            <label className="difficulty-label" htmlFor="difficulty">
              Сложность компьютера
            </label>
            <select
              id="difficulty"
              value={session.settings.difficulty}
              onChange={(event) =>
                session.setSettings({
                  ...session.settings,
                  difficulty: event.target.value as Difficulty,
                })
              }
            >
              {difficulties.map((level) => (
                <option key={level.value} value={level.value}>
                  {level.label}
                </option>
              ))}
            </select>
            <label
              className="difficulty-label color-label"
              htmlFor="player-color"
            >
              Ваш цвет
            </label>
            <select
              id="player-color"
              value={session.settings.color}
              onChange={(event) =>
                session.setSettings({
                  ...session.settings,
                  color: event.target.value as ColorChoice,
                })
              }
            >
              <option value="white">Белые</option>
              <option value="black">Чёрные</option>
              <option value="random">Случайный цвет</option>
            </select>
            <p className="difficulty-help">
              {session.active
                ? `Текущая партия: вы — ${session.playerColor === "w" ? "белые" : "чёрные"}, уровень «${difficulties.find((d) => d.value === session.active!.difficulty)!.label}». Изменения применятся к новой партии.`
                : "Белые начинают. Случайный цвет определяется при каждом старте."}
            </p>
            <button
              type="button"
              className="new-game-button"
              onPointerUp={(event) => {
                if (event.pointerType === "touch") {
                  event.preventDefault();
                  session.startGame();
                }
              }}
              onClick={(event) => {
                // Avoid waiting for compatibility clicks after touch gestures.
                if (
                  event.detail === 0 ||
                  !("pointerType" in event.nativeEvent) ||
                  event.nativeEvent.pointerType !== "touch"
                )
                  session.startGame();
              }}
            >
              {session.active ? "Новая партия" : "Начать партию"}{" "}
              <span aria-hidden="true">↻</span>
            </button>
            {session.engineState === "error" && (
              <div className="engine-error" role="alert">
                <p>{session.engineError}</p>
                <button
                  type="button"
                  className="text-button"
                  onClick={session.retryEngine}
                >
                  Повторить расчёт
                </button>
              </div>
            )}
            {session.active && position.inCheck && !position.result && (
              <p className="check-notice">
                Шах {position.turn === "w" ? "белому" : "чёрному"} королю.
              </p>
            )}
            {session.error && (
              <p className="move-error" role="alert">
                {session.error}
              </p>
            )}
          </section>
          <section
            className="game-panel history-panel"
            aria-labelledby="history-title"
          >
            <div className="history-heading">
              <h2 id="history-title">История ходов</h2>
              <span>{position.history.length} полуходов</span>
            </div>
            {pairs.length ? (
              <div className="history-scroll">
                <table>
                  <thead>
                    <tr>
                      <th scope="col">№</th>
                      <th scope="col">Белые</th>
                      <th scope="col">Чёрные</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pairs.map((moves, index) => (
                      <tr key={index}>
                        <th scope="row">{index + 1}.</th>
                        <td>{moves[0]?.san}</td>
                        <td>{moves[1]?.san ?? "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="history-empty">
                Первый ход — начало истории.
                <br />
                Сделайте свой первый ход.
              </p>
            )}
          </section>
        </aside>
      </div>
      <p className="engine-credit">
        Движок Stockfish.js 19.0.1 ·{" "}
        <a href={`${import.meta.env.BASE_URL}engine/Copying.txt`}>GPL-3.0</a> ·{" "}
        <a href={`${import.meta.env.BASE_URL}engine/SOURCE.txt`}>
          Исходный код и авторы
        </a>
      </p>
      {session.pendingPromotion && (
        <PromotionDialog
          color={position.turn}
          choices={session.pendingPromotion.choices}
          onChoose={session.promote}
          onCancel={session.cancelPromotion}
        />
      )}
    </main>
  );
}
