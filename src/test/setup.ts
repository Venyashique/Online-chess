import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, vi } from "vitest";

afterEach(cleanup);
// jsdom does not implement scrolling; navigation itself is tested in App.test.tsx.
if (typeof window !== "undefined")
  Object.defineProperty(window, "scrollTo", { value: vi.fn(), writable: true });
