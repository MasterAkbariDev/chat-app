import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
} from "@nestjs/common";
import { Response } from "express";

/**
 * `{ error: { code, message } }` — the error half of the response envelope
 * (docs/plans/BACKEND_PLAN.md B1). Applied per-controller (`@UseFilters`) on new `/v1` surface
 * only; legacy routes keep Nest's default `{statusCode, message, error}` shape unchanged.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();

    const status =
      exception instanceof HttpException
        ? exception.getStatus()
        : HttpStatus.INTERNAL_SERVER_ERROR;

    const body =
      exception instanceof HttpException ? exception.getResponse() : null;
    const message =
      typeof body === "string"
        ? body
        : ((body as { message?: string | string[] } | null)?.message ??
          "Internal server error");

    const code =
      typeof body === "object" && body && "error" in body
        ? String((body as { error?: unknown }).error)
        : (HttpStatus[status] ?? "ERROR");

    response.status(status).json({
      error: {
        code,
        message: Array.isArray(message) ? message.join(", ") : message,
      },
    });
  }
}
