import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("theme bootstrap migration", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.resetModules();
  });

  afterEach(() => vi.unstubAllEnvs());

  it("migrates only the configured prefix and preserves current settings", async () => {
    vi.stubEnv("NEXT_PUBLIC_LEGACY_STORAGE_PREFIX", "previous:");
    localStorage.setItem("previous:theme", "rose");
    localStorage.setItem("previous:mode", "light");
    localStorage.setItem("chat:theme", "mono");
    localStorage.setItem("unrelated:mode", "dark");
    const { THEME_BOOTSTRAP_SCRIPT } = await import("./themes");
    new Function(THEME_BOOTSTRAP_SCRIPT)();
    expect(localStorage.getItem("chat:theme")).toBe("mono");
    expect(localStorage.getItem("chat:mode")).toBe("light");
    expect(localStorage.getItem("previous:theme")).toBeNull();
    expect(localStorage.getItem("unrelated:mode")).toBe("dark");
  });

  it("leaves older keys alone when no migration is configured", async () => {
    vi.stubEnv("NEXT_PUBLIC_LEGACY_STORAGE_PREFIX", "");
    localStorage.setItem("previous:theme", "rose");
    const { THEME_BOOTSTRAP_SCRIPT } = await import("./themes");
    new Function(THEME_BOOTSTRAP_SCRIPT)();
    expect(localStorage.getItem("previous:theme")).toBe("rose");
    expect(localStorage.getItem("chat:theme")).toBeNull();
  });
});
