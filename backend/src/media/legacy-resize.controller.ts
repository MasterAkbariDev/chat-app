import { SkipThrottle } from "@nestjs/throttler";
import { Controller, Get, Param, Req, Res } from "@nestjs/common";
import { ApiExcludeController } from "@nestjs/swagger";
import { Request, Response } from "express";
import { Public } from "src/common/decorators/public.decorator";
import { parseCorsAllowlist, isOriginAllowed } from "src/common/cors-allowlist";
import { LegacyResizeService } from "./legacy-resize.service";

export const IMMUTABLE_CACHE = "public, max-age=31536000, immutable";

/**
 * `GET /uploads/_w/<width>/<file>` — a resized WebP of an old `/uploads/<file>` photo
 * (see LegacyResizeService). Lives under `/uploads/` because production nginx only forwards
 * that prefix (plus /api/chat and /socket.io) to the backend. Not rate-limited, like the
 * other media routes: a chat scroll legitimately loads dozens.
 */
@ApiExcludeController()
@SkipThrottle()
@Controller("uploads/_w")
@Public()
export class LegacyResizeController {
  constructor(private readonly resizer: LegacyResizeService) {}

  @Get(":width/*path")
  async serve(
    @Param("width") widthParam: string,
    @Param("path") pathParam: string | string[],
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const relativePath = Array.isArray(pathParam)
      ? pathParam.join("/")
      : pathParam;
    const width = /^\d{1,4}$/.test(widthParam) ? Number(widthParam) : NaN;

    const allowlist = parseCorsAllowlist(process.env.CORS_ORIGIN);
    const origin = req.headers.origin;
    if (isOriginAllowed(origin, allowlist)) {
      res.setHeader("Access-Control-Allow-Origin", origin!);
      res.setHeader("Vary", "Origin");
    }

    const result = await this.resizer.variant(width, relativePath);
    if (result.kind === "not-found") {
      res.setHeader("Cache-Control", "no-store");
      res.status(404).json({ statusCode: 404, message: "Not found" });
      return;
    }
    if (result.kind === "unprocessable") {
      // Too large or undecodable: hand the browser the original instead. Relative, so it
      // keeps whatever path prefix a reverse proxy mounted the API under.
      const depth = relativePath.split("/").length + 1; // "<width>/" + the path's folders
      res.setHeader("Cache-Control", "public, max-age=3600");
      res.redirect(302, `${"../".repeat(depth)}${relativePath}`);
      return;
    }
    res.sendFile(result.path, {
      headers: {
        "Content-Type": "image/webp",
        "Cache-Control": IMMUTABLE_CACHE,
      },
      // `sendFile` would otherwise override our Cache-Control with its own max-age=0.
      cacheControl: false,
    });
  }
}
