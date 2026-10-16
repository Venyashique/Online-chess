import { useState } from "react";
import { Board2D } from "../../shared/chess/ui/Board2D";
import { gameStatus } from "../../shared/chess/session/status";
import { defaultOnlineRepository } from "./data/defaultRepository";
import { useOnlineGame } from "./model/useOnlineGame";
import type { CreatorColorChoice, OnlineGameRepository } from "./model/types";
import "./online.css";

export const openOnlineGame = (id: string) => {
  window.location.hash = `/online/${id}`;
};
function invitationUrl(id: string) {
  const url = new URL(window.location.href);
  url.hash = `/online/${id}`;
  return url.href;
}
const noMoves = () => {};

export function OnlinePage({
  gameId,
  repository = defaultOnlineRepository,
  onCreated = openOnlineGame,
}: {
  gameId?: string;
  repository?: OnlineGameRepository | null;
  onCreated?: (id: string) => void;
} = {}) {
  const session = useOnlineGame(repository, gameId, onCreated);
  const [color, setColor] = useState<CreatorColorChoice>("white");
  const [copyStatus, setCopyStatus] = useState("");
  const game = session.game;
  const pairs = game
    ? Array.from(
        { length: Math.ceil(game.position.history.length / 2) },
        (_, index) => game.position.history.slice(index * 2, index * 2 + 2),
      )
    : [];

  async function copyLink() {
    if (!game) return;
    try {
      await navigator.clipboard.writeText(invitationUrl(game.id));
      setCopyStatus("Ссылка скопирована");
    } catch {
      setCopyStatus(
        "Не удалось скопировать автоматически. Выделите ссылку в поле и скопируйте её.",
      );
    }
  }

  return (
    <main id="main" className="online-page">
      <a className="back-link" href="#/">
        ← На главную
      </a>
      <div className="online-heading">
        <span className="eyebrow">Встретимся за одной доской</span>
        <h1 tabIndex={-1}>Играть онлайн</h1>
        <p>Создайте партию и поделитесь ссылкой с другом.</p>
      </div>
      {!gameId && (
        <section className="online-create" aria-labelledby="create-title">
          <div>
            <span className="eyebrow">Первый шаг к общей партии</span>
            <h2 id="create-title">Ваша следующая встреча</h2>
            <p>
              Партия получит постоянную ссылку. Сейчас доступен просмотр
              сохранённой позиции; ходы и подключение второго игрока появятся
              позже.
            </p>
          </div>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void session.createGame(color);
            }}
          >
            <label htmlFor="creator-color">Цвет создателя</label>
            <select
              id="creator-color"
              value={color}
              disabled={session.creating}
              onChange={(event) =>
                setColor(event.target.value as CreatorColorChoice)
              }
            >
              <option value="white">Белые</option>
              <option value="black">Чёрные</option>
              <option value="random">Случайный цвет</option>
            </select>
            <button
              type="submit"
              className="online-primary"
              disabled={!repository || session.creating}
            >
              {session.creating ? "Создаём партию…" : "Создать партию"}
            </button>
          </form>
        </section>
      )}
      {session.creating && (
        <p role="status" className="online-loading">
          Создаём партию…
        </p>
      )}
      {gameId && session.phase !== "error" && !game && (
        <p role="status" className="online-loading">
          Загружаем партию…
        </p>
      )}
      {session.error && (
        <div className="online-error" role="alert">
          <p>{session.error}</p>
          {gameId && <a href="#/online">Вернуться в онлайн-раздел</a>}
          {repository && gameId && (
            <button
              type="button"
              className="online-text-button"
              onClick={session.reload}
            >
              Повторить загрузку
            </button>
          )}
        </div>
      )}
      {game && (
        <>
          <section className="invitation-panel" aria-labelledby="invite-title">
            <h2 id="invite-title">Ссылка на партию</h2>
            <p className="online-id">
              ID партии: <code>{game.id}</code>
            </p>
            <label htmlFor="invitation-link">Приглашение</label>
            <div className="invitation-controls">
              <input
                id="invitation-link"
                readOnly
                value={invitationUrl(game.id)}
                onFocus={(event) => event.target.select()}
              />
              <button type="button" onClick={() => void copyLink()}>
                Копировать
              </button>
            </div>
            <p className="copy-status" aria-live="polite">
              {copyStatus}
            </p>
            <p className="link-note">
              Любой, у кого есть эта ссылка, может просматривать партию.
            </p>
          </section>
          <div className="online-game-layout">
            <section className="online-board" aria-label="Сохранённая позиция">
              <Board2D
                position={game.position}
                onMove={noMoves}
                disabled
                orientation={game.creatorColor}
              />
              <p className="online-readonly">
                Просмотр партии. Ходы пока недоступны.
              </p>
            </section>
            <aside
              className="online-sidebar"
              aria-label="Информация об онлайн-партии"
            >
              <section className="online-panel">
                <span className="eyebrow">
                  {game.status === "finished"
                    ? "Партия завершена"
                    : game.status === "waiting"
                      ? "Партия создана"
                      : "Сохранённая партия"}
                </span>
                <p className="online-game-status" role="status">
                  {gameStatus(game.position)}
                </p>
                <p>
                  Создатель:{" "}
                  <strong>
                    {game.creatorColor === "w" ? "белые" : "чёрные"}
                  </strong>
                </p>
                <p>
                  Второй игрок:{" "}
                  <strong>
                    {game.secondPlayerColor === "w" ? "белые" : "чёрные"}
                  </strong>
                </p>
                {game.creatorColorChoice === "random" && (
                  <p className="online-small">
                    Цвет определён случайно при создании.
                  </p>
                )}
                <button
                  type="button"
                  className="online-text-button"
                  onClick={session.reload}
                >
                  Обновить позицию
                </button>
              </section>
              <section
                className="online-panel"
                aria-labelledby="online-history-title"
              >
                <h2 id="online-history-title">История ходов</h2>
                {pairs.length ? (
                  <div className="online-history">
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
                  <p className="online-small">В партии ещё нет ходов.</p>
                )}
              </section>
              <a className="online-back" href="#/online">
                Создать другую партию →
              </a>
            </aside>
          </div>
        </>
      )}
    </main>
  );
}
