import type { Request, Response } from "express";
import {
  deliverRefreshToken,
  REFRESH_COOKIE,
  resolveRefreshToken,
} from "./refresh-cookie";

const req = (headers: Record<string, string>) =>
  ({ headers }) as unknown as Request;

describe("refresh-cookie", () => {
  beforeEach(() => {
    process.env.CORS_ORIGIN = "http://localhost:8080";
  });

  it("reads the cookie for a cookie-transport request", () => {
    const r = req({
      "x-auth-transport": "cookie",
      origin: "http://localhost:8080",
      cookie: `a=1; ${REFRESH_COOKIE}=abc123; b=2`,
    });
    expect(resolveRefreshToken(r, undefined)).toBe("abc123");
  });

  it("uses the body token for native clients and ignores any cookie", () => {
    const r = req({ cookie: `${REFRESH_COOKIE}=fromcookie` });
    expect(resolveRefreshToken(r, "frombody")).toBe("frombody");
  });

  it("rejects a cookie-transport request from a foreign origin", () => {
    const r = req({
      "x-auth-transport": "cookie",
      origin: "https://evil.example",
      cookie: `${REFRESH_COOKIE}=abc123`,
    });
    expect(() => resolveRefreshToken(r, undefined)).toThrow();
  });

  it("sets an HttpOnly cookie and strips the token from the body", () => {
    const cookie = jest.fn();
    const res = { cookie } as unknown as Response;
    const out = deliverRefreshToken(
      req({ "x-auth-transport": "cookie" }),
      res,
      {
        access_token: "a",
        refresh_token: "r",
      },
    );
    expect(out).toEqual({ access_token: "a" });
    expect(cookie).toHaveBeenCalledWith(
      REFRESH_COOKIE,
      "r",
      expect.objectContaining({ httpOnly: true }),
    );
  });

  it("leaves the body untouched for native clients", () => {
    const cookie = jest.fn();
    const payload = { access_token: "a", refresh_token: "r" };
    const out = deliverRefreshToken(
      req({}),
      { cookie } as unknown as Response,
      payload,
    );
    expect(out).toBe(payload);
    expect(cookie).not.toHaveBeenCalled();
  });
});
