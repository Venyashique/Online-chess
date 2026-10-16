import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ComputerPage } from "./ComputerPage";
import { useGameSession } from "../../shared/chess/session/useGameSession";
import { Board2D } from "../../shared/chess/ui/Board2D";
import { PromotionDialog } from "../../shared/chess/ui/PromotionDialog";
import type { ChessEngine } from "../../shared/chess/engine/types";
import type { MoveAction } from "../../shared/chess/domain/types";

async function move(
  user: ReturnType<typeof userEvent.setup>,
  from: string,
  to: string,
) {
  await user.click(
    screen.getByRole("button", { name: new RegExp(`^${from},`) }),
  );
  await user.click(screen.getByRole("button", { name: new RegExp(`^${to},`) }));
}

function deferredEngine() {
  let resolve!: (move: MoveAction | null) => void;
  const engine: ChessEngine = {
    chooseMove: vi.fn(
      () =>
        new Promise<MoveAction | null>((done) => {
          resolve = done;
        }),
    ),
    dispose: vi.fn(),
  };
  return {
    factory: () => engine,
    engine,
    answer: (move: MoveAction) => resolve(move),
  };
}

describe("Computer screen", () => {
  it("starts a game, shows thinking, accepts engine reply and resets", async () => {
    const user = userEvent.setup();
    const h = deferredEngine();
    render(<ComputerPage engineFactory={h.factory} />);
    expect(
      screen.getByRole("button", { name: "e2, белые пешка" }),
    ).toBeDisabled();
    await user.selectOptions(
      screen.getByLabelText("Сложность компьютера"),
      "hard",
    );
    await user.click(screen.getByRole("button", { name: /Начать партию/ }));
    await move(user, "e2", "e4");
    await waitFor(() => expect(h.engine.chooseMove).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("status")).toHaveTextContent("Компьютер думает");
    expect(
      screen.getByRole("button", { name: "e7, чёрные пешка" }),
    ).toBeDisabled();
    await act(async () => h.answer({ from: "e7", to: "e5" }));
    expect(screen.getByRole("status")).toHaveTextContent("Ход белых");
    expect(screen.getByRole("cell", { name: "e5" })).toBeVisible();
    expect(
      screen.getByRole("button", { name: "e4, белые пешка" }),
    ).toBeVisible();
    await user.click(screen.getByRole("button", { name: /Новая партия/ }));
    expect(
      screen.getByRole("button", { name: "e2, белые пешка" }),
    ).toBeVisible();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Сложность компьютера")).toHaveValue("hard");
  });

  it("rejects illegal moves and supports keyboard input", async () => {
    const user = userEvent.setup();
    const h = deferredEngine();
    render(<ComputerPage engineFactory={h.factory} />);
    await user.click(screen.getByRole("button", { name: /Начать партию/ }));
    await move(user, "e2", "e5");
    expect(screen.getByRole("alert")).toHaveTextContent("недопустим");
    await user.keyboard("{Escape}");
    screen.getByRole("button", { name: "e2, белые пешка" }).focus();
    await user.keyboard("{Enter}{ArrowUp}{ArrowUp}{Enter}");
    expect(
      screen.getByRole("button", { name: "e4, белые пешка" }),
    ).toBeVisible();
  });

  it("shows mate from the computer and locks the ended board", async () => {
    const user = userEvent.setup();
    const chooseMove = vi
      .fn()
      .mockResolvedValueOnce({ from: "e7", to: "e5" })
      .mockResolvedValueOnce({ from: "d8", to: "h4" });
    const factory = () => ({ chooseMove, dispose: vi.fn() });
    render(<ComputerPage engineFactory={factory} />);
    await user.click(screen.getByRole("button", { name: /Начать партию/ }));
    await move(user, "f2", "f3");
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent("Ход белых"),
    );
    await move(user, "g2", "g4");
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent(
        "Мат. Победа чёрных.",
      ),
    );
    expect(
      screen.getByRole("button", { name: "a2, белые пешка" }),
    ).toBeDisabled();
    expect(chooseMove).toHaveBeenCalledTimes(2);
    await user.click(screen.getByRole("button", { name: /Новая партия/ }));
    expect(
      screen.getByRole("button", { name: "a2, белые пешка" }),
    ).toBeEnabled();
  });

  it("orients the board for black and shows player/computer colors", async () => {
    const user = userEvent.setup();
    const h = deferredEngine();
    render(<ComputerPage engineFactory={h.factory} />);
    await user.selectOptions(screen.getByLabelText("Ваш цвет"), "black");
    await user.click(screen.getByRole("button", { name: /Начать партию/ }));
    const buttons = within(
      screen.getByRole("group", { name: "Шахматная доска" }),
    ).getAllByRole("button");
    expect(buttons[0]).toHaveAttribute("data-square", "h1");
    expect(buttons[63]).toHaveAttribute("data-square", "a8");
    expect(screen.getByText(/Текущая партия: вы — чёрные/)).toBeVisible();
    await waitFor(() => expect(h.engine.chooseMove).toHaveBeenCalledTimes(1));
    await act(async () => h.answer({ from: "e2", to: "e4" }));
    expect(screen.getByRole("status")).toHaveTextContent("Ход чёрных");
    expect(
      screen.getByRole("button", { name: "e7, чёрные пешка" }),
    ).toBeEnabled();
  });
});

function PromotionHarness() {
  const session = useGameSession("computer", "7k/P7/8/8/8/8/8/7K w - - 0 1");
  return (
    <>
      <Board2D
        position={session.position}
        onMove={session.requestMove}
        disabled={!!session.pendingPromotion}
      />
      {session.pendingPromotion && (
        <PromotionDialog
          color={session.position.turn}
          choices={session.pendingPromotion.choices}
          onChoose={session.promote}
          onCancel={session.cancelPromotion}
        />
      )}
    </>
  );
}

it("asks for promotion, can cancel, and applies the chosen piece", async () => {
  const user = userEvent.setup();
  render(<PromotionHarness />);
  await move(user, "a7", "a8");
  expect(
    screen.getByRole("dialog", { name: "Превращение пешки" }),
  ).toBeVisible();
  expect(
    screen.getByRole("button", { name: "a7, белые пешка" }),
  ).toBeDisabled();
  await user.click(screen.getByRole("button", { name: "Отмена" }));
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  await move(user, "a7", "a8");
  await user.click(screen.getByRole("button", { name: "Конь" }));
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "a8, белые конь" }),
    ).toBeVisible(),
  );
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});
