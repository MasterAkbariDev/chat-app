import { describe, expect, it } from "vitest";
import { clientIp, ipv4ToInt, isAllowed, parseAllowlist, parseEntry } from "./ip-allowlist";

describe("ipv4ToInt", () => {
  it("parses dotted quads and rejects everything else", () => {
    expect(ipv4ToInt("0.0.0.1")).toBe(1);
    expect(ipv4ToInt("203.0.113.9")).toBe(((203 << 24) | (0 << 16) | (113 << 8) | 9) >>> 0);
    expect(ipv4ToInt("256.0.0.1")).toBeNull();
    expect(ipv4ToInt("::1")).toBeNull();
    expect(ipv4ToInt("example.com")).toBeNull();
  });
});

describe("parseAllowlist", () => {
  it("is empty when unset or blank", () => {
    expect(parseAllowlist(undefined)).toEqual([]);
    expect(parseAllowlist("   ")).toEqual([]);
  });

  it("throws on a bad entry so a typo fails at startup, not silently open", () => {
    expect(() => parseAllowlist("203.0.113.0/33")).toThrow(/invalid prefix/);
    expect(() => parseAllowlist("not-an-ip")).toThrow(/not an IPv4/);
  });
});

describe("isAllowed", () => {
  const list = parseAllowlist("203.0.113.0/24, 198.51.100.7");

  it("allows addresses inside a CIDR block and exact addresses", () => {
    expect(isAllowed("203.0.113.1", list)).toBe(true);
    expect(isAllowed("203.0.113.254", list)).toBe(true);
    expect(isAllowed("198.51.100.7", list)).toBe(true);
  });

  it("refuses addresses just outside, and an unknown client", () => {
    expect(isAllowed("203.0.114.1", list)).toBe(false);
    expect(isAllowed("198.51.100.8", list)).toBe(false);
    expect(isAllowed(null, list)).toBe(false);
    expect(isAllowed("garbage", list)).toBe(false);
  });

  it("with an empty list nothing is allowed", () => {
    expect(isAllowed("203.0.113.1", [])).toBe(false);
  });

  it("a /0 entry allows everything (an explicit choice by the operator)", () => {
    expect(isAllowed("10.1.2.3", [parseEntry("0.0.0.0/0")])).toBe(true);
  });
});

describe("clientIp", () => {
  it("ignores X-Forwarded-For unless the proxy is trusted", () => {
    const h = new Headers({ "x-forwarded-for": "203.0.113.9, 10.0.0.1" });
    expect(clientIp(h, false)).toBeNull();
    expect(clientIp(h, true)).toBe("203.0.113.9");
  });

  it("is null when no forwarded header is present", () => {
    expect(clientIp(new Headers(), true)).toBeNull();
  });
});
