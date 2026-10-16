import { ArrowIcon } from "./ArrowIcon";
type FeaturePlaceholderProps = {
  title: string;
  description: string;
  symbol: string;
};

export function FeaturePlaceholder({
  title,
  description,
  symbol,
}: FeaturePlaceholderProps) {
  return (
    <main id="main" className="placeholder">
      <a className="back-link" href="#/">
        ← На главную
      </a>
      <div className="placeholder-panel">
        <span className="placeholder-symbol" aria-hidden="true">
          {symbol}
        </span>
        <span className="eyebrow">Скоро в Online Chess</span>
        <h1 tabIndex={-1}>{title}</h1>
        <p>{description}</p>
        <p className="placeholder-note">
          Этот раздел пока в разработке. А каждая большая партия начинается с
          первого хода.
        </p>
        <a className="primary-link" href="#/">
          Вернуться на главную{" "}
          <span aria-hidden="true">
            <ArrowIcon />
          </span>
        </a>
      </div>
    </main>
  );
}
