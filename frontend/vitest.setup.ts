import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

// This project's tests import `afterEach`/`describe`/etc. explicitly rather
// than relying on vitest's `globals: true` — Testing Library's own
// auto-cleanup only registers itself when it detects a *global* `afterEach`,
// so without this it silently doesn't run, and each rendered component
// keeps stacking up in `document.body` across tests within the same file.
afterEach(() => {
  cleanup();
});
