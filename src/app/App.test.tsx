import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { App } from "./App";

beforeEach(() => {
  window.history.replaceState(null, "", "/");
});

describe("Application foundation", () => {
  it("shows the home page and three available directions", () => {
    render(<App />);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(
      "Ваш первый ход.",
    );
    for (const title of ["Играть с компьютером", "Играть онлайн", "Обучение"]) {
      expect(screen.getByRole("heading", { name: title })).toBeVisible();
    }
    expect(
      screen.getByRole("link", { name: "Online Chess — главная" }),
    ).toBeVisible();
  });

  it.each([
    ["Играть с компьютером", "#/computer"],
    ["Играть онлайн", "#/online"],
    ["Обучение", "#/learning"],
  ])("opens %s and returns home", async (title, path) => {
    const user = userEvent.setup();
    render(<App />);
    const heading = screen.getByRole("heading", { name: title });
    await user.click(heading.closest("a")!);
    await waitFor(() => expect(window.location.hash).toBe(path));
    const pageTitle = await screen.findByRole("heading", {
      level: 1,
      name: title,
    });
    expect(pageTitle).toHaveFocus();
    if (path === "#/computer") {
      expect(
        screen.getByRole("group", { name: "Шахматная доска" }),
      ).toBeVisible();
    } else if (path === "#/online") {
      expect(
        screen.getByRole("button", { name: "Создать партию" }),
      ).toBeVisible();
    } else {
      expect(screen.getByText(/Этот раздел пока в разработке/)).toBeVisible();
    }
    await user.click(screen.getByRole("link", { name: "← На главную" }));
    await waitFor(() =>
      expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(
        "Ваш первый ход.",
      ),
    );
  });

  it("opens a section directly from its URL", () => {
    window.history.replaceState(null, "", "/#/online");
    render(<App />);
    expect(
      screen.getByRole("heading", { level: 1, name: "Играть онлайн" }),
    ).toBeVisible();
  });
});
