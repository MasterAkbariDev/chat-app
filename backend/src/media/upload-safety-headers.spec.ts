import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as express from "express";
import * as request from "supertest";
import { setUploadSafetyHeaders } from "./upload-safety-headers";

describe("generic upload safety headers", () => {
  const directory = mkdtempSync(join(tmpdir(), "chat-upload-test-"));
  const app = express();

  beforeAll(() => {
    writeFileSync(join(directory, "payload.html"), "<script>alert(1)</script>");
    writeFileSync(join(directory, "picture.png"), "example");
    app.use(
      "/uploads",
      express.static(directory, { setHeaders: setUploadSafetyHeaders }),
    );
  });

  afterAll(() => rmSync(directory, { recursive: true, force: true }));

  it("forces active uploads to download with a restrictive CSP", async () => {
    const response = await request(app).get("/uploads/payload.html");
    expect(response.status).toBe(200);
    expect(response.headers["content-disposition"]).toBe("attachment");
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.headers["content-security-policy"]).toBe(
      "default-src 'none'; sandbox",
    );
  });

  it("keeps ordinary image uploads available inline", async () => {
    const response = await request(app).get("/uploads/picture.png");
    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toMatch(/^image\/png/);
    expect(response.headers["content-disposition"]).toBeUndefined();
    expect(response.headers["content-security-policy"]).toBe(
      "default-src 'none'; sandbox",
    );
  });
});
