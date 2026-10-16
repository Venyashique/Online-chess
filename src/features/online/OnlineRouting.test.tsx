import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { App } from "../../app/App";
import { existingGameId } from "../../test/onlineFixtures";

vi.mock("./data/defaultRepository", async () => {
  const { onlineGameFixture, existingGameId } =
    await import("../../test/onlineFixtures");
  return {
    defaultOnlineRepository: {
      createGame: vi.fn(async () => onlineGameFixture()),
      getGame: vi.fn(async (id: string) =>
        id === existingGameId ? onlineGameFixture() : null,
      ),
    },
  };
});

it("navigates from lobby to a saved game URL and supports reopening that URL", async () => {
  window.history.replaceState(null, "", "/#/online");
  const user = userEvent.setup();
  const { unmount } = render(<App />);
  await user.click(screen.getByRole("button", { name: "Создать партию" }));
  await waitFor(() =>
    expect(window.location.hash).toBe(`#/online/${existingGameId}`),
  );
  expect(
    await screen.findByRole("group", { name: "Шахматная доска" }),
  ).toBeVisible();
  unmount();
  render(<App />);
  expect(
    ((await screen.findByLabelText("Приглашение")) as HTMLInputElement).value,
  ).toContain(existingGameId);
  expect(document.title).toContain("Играть онлайн");
});
