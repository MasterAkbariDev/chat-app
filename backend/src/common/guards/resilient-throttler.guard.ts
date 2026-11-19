import { Injectable, Logger } from "@nestjs/common";
import {
  ThrottlerException,
  ThrottlerGuard,
  ThrottlerRequest,
} from "@nestjs/throttler";

/**
 * `ThrottlerGuard.handleRequest` lets any error from the Redis storage call (not just an
 * actual rate-limit hit) propagate as an unhandled 500 — so a Redis blip takes down every
 * throttled route on the whole API, which by B0 is nearly all of them (global `APP_GUARD`).
 * This subclass fails OPEN on a storage error (logs and lets the request through) while still
 * enforcing the limit normally whenever the storage call succeeds. See docs/plans/BACKEND_PLAN.md.
 */
@Injectable()
export class ResilientThrottlerGuard extends ThrottlerGuard {
  private readonly logger = new Logger(ResilientThrottlerGuard.name);

  protected async handleRequest(
    requestProps: ThrottlerRequest,
  ): Promise<boolean> {
    try {
      return await super.handleRequest(requestProps);
    } catch (err) {
      if (err instanceof ThrottlerException) {
        throw err; // a real rate-limit hit — not a storage failure, must still block
      }
      this.logger.warn(
        `Throttler storage unavailable, allowing request through: ${String(err)}`,
      );
      return true;
    }
  }
}
