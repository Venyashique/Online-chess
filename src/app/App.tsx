import { ArrowIcon } from "../shared/ui/ArrowIcon";
import { useEffect, useState } from "react";
import { HomePage } from "../pages/HomePage";
import { ComputerPage } from "../features/computer/ComputerPage";
import { OnlinePage } from "../features/online/OnlinePage";
import { LearningPage } from "../features/learning/LearningPage";
import { ChessMark } from "../shared/ui/ChessMark";

function CurrentPage({ hash }: { hash: string }) {
  if (hash.startsWith("#/online/")) {
    const gameId = hash.slice("#/online/".length);
    return <OnlinePage key={gameId} gameId={gameId} />;
  }
  switch (hash) {
    case "#/computer":
      return <ComputerPage />;
    case "#/online":
      return <OnlinePage />;
    case "#/learning":
      return <LearningPage />;
    default:
      return <HomePage />;
  }
}

export function App() {
  const [hash, setHash] = useState(window.location.hash);
  useEffect(() => {
    const onHashChange = () => setHash(window.location.hash);
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  // Announce each page change to keyboard and assistive-technology users.
  useEffect(() => {
    document.title = `${hash === "#/computer" ? "Играть с компьютером" : hash.startsWith("#/online") ? "Играть онлайн" : hash === "#/learning" ? "Обучение" : "Ваш первый ход"} — Online Chess`;
    if (hash.startsWith("#/")) {
      document.querySelector<HTMLElement>("h1")?.focus({ preventScroll: true });
      window.scrollTo?.(0, 0);
    }
  }, [hash]);

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main">
        К содержимому
      </a>
      <header className="site-header">
        <a className="brand" href="#/" aria-label="Online Chess — главная">
          <ChessMark />
          <span>
            Online Chess<span className="brand-dot">.</span>
          </span>
        </a>
        <span className="header-note">
          Классическая игра. Новые возможности.
        </span>
        <a className="header-link" href="#/learning">
          Открыть шахматы{" "}
          <span aria-hidden="true">
            <ArrowIcon />
          </span>
        </a>
      </header>
      <CurrentPage hash={hash} />
      <footer className="site-footer">
        <span>Online Chess</span>
        <span>Сделано для любви к игре.</span>
        <span>Первый ход — начало истории</span>
      </footer>
    </div>
  );
}
