#!/usr/bin/env node
// F11's own acceptance criterion: "Lighthouse: a11y ≥ 95, perf budget green,
// on every route." No supporting tooling existed at all before this script
// (confirmed: no `lighthouse`/`@lhci/cli` anywhere in this repo's
// package.jsons, no global CLI installed).
//
// The app authenticates with a bearer token in localStorage, not a cookie
// (see lib/api/token-store.ts) — a plain `lighthouse <url>` run against an
// `/app/*` route would just audit the client-side redirect-to-`/login` it
// hits with no session, not the real screen. This script launches Chrome via
// puppeteer-core, injects a real access/refresh token pair into localStorage
// for the app's origin, then runs Lighthouse's classic Node API against that
// same already-authenticated browser/profile (`disableStorageReset: true` —
// otherwise Lighthouse clears storage before every audit, wiping the tokens
// right back out).
//
// Usage:
//   CHROME_PATH=<path to a Chrome/Chromium binary> \
//   LH_BASE_URL=http://localhost:3098 \
//   LH_ACCESS_TOKEN=<real access_token> \
//   LH_REFRESH_TOKEN=<real refresh_token> \
//   node scripts/lighthouse-audit.mjs
//
// Public routes (no auth needed) are audited regardless; the two
// LH_*_TOKEN vars are only required to also audit the authenticated routes.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import puppeteer from "puppeteer-core";
import lighthouse from "lighthouse";

const CHROME_PATH = process.env.CHROME_PATH;
const BASE_URL = process.env.LH_BASE_URL ?? "http://localhost:3000";
const ACCESS_TOKEN = process.env.LH_ACCESS_TOKEN;
const REFRESH_TOKEN = process.env.LH_REFRESH_TOKEN;
const DEBUG_PORT = Number(process.env.LH_DEBUG_PORT ?? 9222);
const OUT_DIR = path.join(process.cwd(), ".lighthouse");

const PUBLIC_ROUTES = ["/login", "/register", "/forgot-password"];
const AUTH_ROUTES = ["/app", "/app/contacts", "/app/settings"];

if (!CHROME_PATH) {
  console.error("Set CHROME_PATH to a Chrome/Chromium executable.");
  process.exit(1);
}

function summarize(runnerResult) {
  const { categories } = runnerResult.lhr;
  const pct = c => (c ? Math.round(c.score * 100) : null);
  return {
    performance: pct(categories.performance),
    accessibility: pct(categories.accessibility),
    "best-practices": pct(categories["best-practices"]),
    seo: pct(categories.seo),
  };
}

async function auditRoute(route, port) {
  const url = `${BASE_URL}${route}`;
  const result = await lighthouse(url, {
    port,
    output: "json",
    logLevel: "error",
    onlyCategories: ["performance", "accessibility", "best-practices", "seo"],
    disableStorageReset: true,
    formFactor: "desktop",
    // A *real* desktop viewport, not puppeteer's small headless default —
    // `/app`'s own layout hides its `<main>` below Tailwind's `lg` (1024px)
    // breakpoint on purpose (mobile shows the chat list full-screen instead,
    // master-detail only at desktop widths), so auditing at a narrow width
    // produced a false "no main landmark" finding.
    screenEmulation: { mobile: false, width: 1440, height: 940, deviceScaleFactor: 1, disabled: false },
  });
  mkdirSync(OUT_DIR, { recursive: true });
  const safeName = route === "/" ? "root" : route.replaceAll("/", "_").slice(1);
  writeFileSync(path.join(OUT_DIR, `${safeName}.json`), result.report);
  return { route, ...summarize(result) };
}

async function main() {
  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: true,
    args: [`--remote-debugging-port=${DEBUG_PORT}`, "--no-sandbox"],
  });

  // A production `next start` server compiles nothing lazily, but its very
  // first request of the run still measured a wildly unrepresentative
  // performance score in practice (a `LanternError: NO_LCP` on the first
  // route only) — one throwaway warmup request avoids scoring that.
  await fetch(BASE_URL).catch(() => {});

  const results = [];
  try {
    for (const route of PUBLIC_ROUTES) {
      results.push(await auditRoute(route, DEBUG_PORT));
    }

    if (ACCESS_TOKEN && REFRESH_TOKEN) {
      const page = await browser.newPage();
      // localStorage is origin-scoped — load a page on this origin first so
      // there's a document to attach the write to, matching exactly the
      // keys token-store.ts itself reads (`getAccessToken`/`getRefreshToken`).
      await page.goto(`${BASE_URL}/login`, { waitUntil: "domcontentloaded" });
      await page.evaluate(
        (access, refresh) => {
          localStorage.setItem("chat:access-token", access);
          localStorage.setItem("chat:refresh-token", refresh);
        },
        ACCESS_TOKEN,
        REFRESH_TOKEN,
      );
      await page.close();

      for (const route of AUTH_ROUTES) {
        results.push(await auditRoute(route, DEBUG_PORT));
      }
    } else {
      console.warn("LH_ACCESS_TOKEN/LH_REFRESH_TOKEN not set — skipping authenticated routes.");
    }
  } finally {
    await browser.close();
  }

  console.table(results);
  writeFileSync(path.join(OUT_DIR, "summary.json"), JSON.stringify(results, null, 2));
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
