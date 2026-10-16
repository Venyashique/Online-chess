import { ArrowIcon } from "../shared/ui/ArrowIcon";
import { ChessMark } from "../shared/ui/ChessMark";

const modes = [
  {
    path: "computer",
    number: "01",
    symbol: "♞",
    title: "Играть с компьютером",
    description:
      "Своя партия, свой темп. Соперник, который всегда готов к игре.",
    tag: "Практика",
    color: "green",
  },
  {
    path: "online",
    number: "02",
    symbol: "♜",
    title: "Играть онлайн",
    description:
      "Шахматы сближают. Пригласите друга, даже если вы далеко друг от друга.",
    tag: "Вместе",
    color: "sand",
  },
  {
    path: "learning",
    number: "03",
    symbol: "♙",
    title: "Обучение",
    description:
      "От первого хода к своей стратегии. Откройте для себя мир шахмат.",
    tag: "С нуля",
    color: "lavender",
  },
] as const;

export function HomePage() {
  return (
    <main id="main">
      <section className="hero" aria-labelledby="hero-title">
        <div className="hero-copy">
          <span className="eyebrow">
            <span className="status-dot" /> Место для вашей следующей партии
          </span>
          <h1 id="hero-title" tabIndex={-1}>
            Большая игра.
            <br />
            <em>Ваш первый ход.</em>
          </h1>
          <p>
            Пара минут для себя или целый вечер с другом.
            <br className="desktop-break" /> Играйте, пробуйте и открывайте
            шахматы заново.
          </p>
          <a className="primary-link" href="#modes">
            Выбрать свой формат{" "}
            <span aria-hidden="true">
              <ArrowIcon />
            </span>
          </a>
          <div className="hero-caption">
            <span aria-hidden="true">✦</span> Одна игра. Бесконечно много
            возможностей.
          </div>
        </div>
        <div className="hero-art" aria-hidden="true">
          <div className="orbit orbit-one" />
          <div className="orbit orbit-two" />
          <span className="art-label">Ход за вами</span>
          <div className="tile tile-back" />
          <div className="tile tile-front" />
          <ChessMark className="hero-piece" />
          <span className="art-spark">✳</span>
          <span className="art-coordinate">e2 → e4</span>
        </div>
      </section>
      <section id="modes" className="modes" aria-labelledby="modes-title">
        <div className="section-heading">
          <div>
            <span className="eyebrow">Найдите свою игру</span>
            <h2 id="modes-title">С чего начнём?</h2>
          </div>
          <p>Три направления. Ваша история.</p>
        </div>
        <div className="mode-grid">
          {modes.map((mode) => (
            <a
              className={`mode-card ${mode.color}`}
              href={`#/${mode.path}`}
              key={mode.path}
            >
              <div className="card-top">
                <span className="mode-symbol" aria-hidden="true">
                  {mode.symbol}
                </span>
                <span className="mode-number">{mode.number}</span>
              </div>
              <div>
                <span className="mode-tag">{mode.tag}</span>
                <h3>{mode.title}</h3>
                <p>{mode.description}</p>
              </div>
              <div className="card-bottom">
                <span>
                  {mode.path === "computer" ? "Попробовать" : "Скоро"}
                </span>
                <span className="card-arrow" aria-hidden="true">
                  <ArrowIcon />
                </span>
              </div>
            </a>
          ))}
        </div>
      </section>
      <div className="closing-note">
        <span aria-hidden="true">♟</span>
        <p>
          Неважно, сколько партий позади.
          <br />
          <strong>Следующая всегда может стать особенной.</strong>
        </p>
      </div>
    </main>
  );
}
