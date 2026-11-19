import { SkipThrottle } from "@nestjs/throttler";
import { Controller, Get, Param, Req, Res } from "@nestjs/common";
import { ApiExcludeController } from "@nestjs/swagger";
import { Request, Response } from "express";
import { Public } from "src/common/decorators/public.decorator";
import { parseCorsAllowlist, isOriginAllowed } from "src/common/cors-allowlist";
import { LegacyPosterService } from "./legacy-poster.service";
import { IMMUTABLE_CACHE } from "./legacy-resize.controller";

/**
 * `GET /uploads/_poster/<file>.mp4` — a JPEG first frame of an old `/uploads/<file>` video
 * (see LegacyPosterService). Under `/uploads/` for the same nginx reason as `_w`.
 */
@ApiExcludeController()
@SkipThrottle()
@Controller("uploads/_poster")
@Public()
export class LegacyPosterController {
  constructor(private readonly posters: LegacyPosterService) {}

  @Get("*path")
  async serve(
    @Param("path") pathParam: string | string[],
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const relativePath = Array.isArray(pathParam)
      ? pathParam.join("/")
      : pathParam;

    const allowlist = parseCorsAllowlist(process.env.CORS_ORIGIN);
    const origin = req.headers.origin;
    if (isOriginAllowed(origin, allowlist)) {
      res.setHeader("Access-Control-Allow-Origin", origin!);
      res.setHeader("Vary", "Origin");
    }

    const result = await this.posters.poster(relativePath);
    if (result.kind !== "file") {
      // A clip that won't decode is retried at most hourly, not on every chat render.
      res.setHeader(
        "Cache-Control",
        result.kind === "unprocessable" ? "public, max-age=3600" : "no-store",
      );
      res.status(404).json({ statusCode: 404, message: "Not found" });
      return;
    }
    res.sendFile(result.path, {
      headers: {
        "Content-Type": "image/jpeg",
        "Cache-Control": IMMUTABLE_CACHE,
      },
      cacheControl: false,
    });
  }
}
