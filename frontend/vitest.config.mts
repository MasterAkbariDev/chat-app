import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tsconfigPaths from "vite-tsconfig-paths";

// `.mts`, not `.ts` — this project has no `"type": "module"` in
// package.json (same reason `eslint.config.mjs`/`postcss.config.mjs` use an
// explicit extension instead), and both `vite` and `vite-tsconfig-paths`
// ship ESM-only builds now. Vitest's config loader `require()`s a plain
// `.ts` config as CommonJS by default, which can't load either package —
// the explicit `.mts` extension forces Node to load this file as real ESM
// regardless of package.json's `type` field.
//
// jsdom + @testing-library/react added for real component tests (F0's own
// checklist named this as the one remaining piece after the first,
// logic-only pass) — tsconfigPaths resolves the same `@/*` alias
// tsconfig.json already declares, so test files import the same way the
// app does rather than via relative paths.
//
// `jsdom` is pinned to exactly 27.0.0 (not the newer `^30.1.1` this project
// used until 2026-09-29), and `npm test` sets
// `NODE_OPTIONS=--experimental-require-module` — found live-debugging a
// sudden "Tests 0, Errors 6" failure with no source change to blame.
// jsdom@28+'s dependency tree (html-encoding-sniffer, whatwg-url, data-urls)
// adopted `@exodus/bytes`, an ESM-only package, and jsdom@30 additionally
// pulls in `undici@8.x` (via a newer sub-dependency), which calls a
// `webidl.util.markAsUncloneable` Node built-in that doesn't exist before
// Node 22.19 — this machine runs 22.9. jsdom@27.0.0's tree avoids the
// undici issue entirely, but still has one ESM-only leaf of its own
// (`@csstools/css-calc`, via its CSS-value-resolution dependency) that
// needs the require-module flag. Confirmed by testing each layer in
// isolation (a bare `node -e` reproduction) rather than guessing — don't
// bump `jsdom` past 27.x on this Node version without re-checking both
// failure modes.
export default defineConfig({
  plugins: [react(), tsconfigPaths()],
  test: {
    environment: "jsdom",
    setupFiles: ["./vitest.setup.ts"],
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
  },
});
