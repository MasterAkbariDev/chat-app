import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { App, cert, initializeApp, ServiceAccount } from "firebase-admin/app";
import { getMessaging } from "firebase-admin/messaging";

export interface FcmSendResult {
  ok: boolean;
  /** True when FCM says the token is dead (uninstalled, expired) — caller should delete it. */
  invalidToken: boolean;
  /** True when FCM is down or pushing back (try again later), as opposed to a dead token. */
  transient?: boolean;
}

/** FCM answers with these when it's down, overloaded or refusing for now. */
const TRANSIENT_CODES = new Set([
  "messaging/internal-error",
  "messaging/server-unavailable",
  "messaging/service-unavailable",
  "messaging/quota-exceeded",
  "messaging/too-many-requests",
  "messaging/unknown-error",
]);

/** Consecutive transient failures before FCM counts as degraded (and sends wait for a probe). */
const DEGRADED_AFTER = 3;

/**
 * Thin wrapper around `firebase-admin`'s messaging API (B7, docs/plans/BACKEND_PLAN.md — Android/
 * Flutter push only, no APNs/iOS). Uses the modular `firebase-admin/app` + `firebase-admin/
 * messaging` entry points — v14 moved off the old `admin.initializeApp()`/`admin.messaging()`
 * namespace API those subpaths replace. Reads the service-account key from
 * `FCM_SERVICE_ACCOUNT_PATH` or the default `backend/secrets/fcm-service-account.json` — if
 * neither exists, every send is a no-op (logged once at boot, not on every message) so the rest
 * of the app works normally in an environment with no FCM credentials configured.
 */
@Injectable()
export class FcmService implements OnModuleInit {
  private readonly logger = new Logger(FcmService.name);
  private app: App | null = null;

  onModuleInit(): void {
    const keyPath =
      process.env.FCM_SERVICE_ACCOUNT_PATH ??
      join(process.cwd(), "secrets", "fcm-service-account.json");
    if (!existsSync(keyPath)) {
      this.logger.warn(
        `No FCM service-account key at ${keyPath} — push notifications are disabled ` +
          "(set FCM_SERVICE_ACCOUNT_PATH or place the key at that path).",
      );
      return;
    }
    try {
      const serviceAccount = JSON.parse(
        readFileSync(keyPath, "utf-8"),
      ) as ServiceAccount;
      this.app = initializeApp({ credential: cert(serviceAccount) }, "fcm");
    } catch (err) {
      this.logger.error(
        `Failed to initialize FCM from ${keyPath}: ${String(err)}`,
      );
    }
  }

  get isConfigured(): boolean {
    return this.app !== null;
  }

  /**
   * A data-only, high-priority push (incoming call / call over). No `notification` block on
   * purpose: the receiving service worker / app decides what to show — an "Incoming call"
   * notification with Answer/Decline, or withdrawing it — instead of the browser showing a
   * plain one by itself. `ttlSec` keeps a ring from being delivered after it already ended.
   */
  async sendData(
    token: string,
    data: Record<string, string>,
    ttlSec: number,
  ): Promise<FcmSendResult> {
    if (!this.app) return { ok: false, invalidToken: false };
    try {
      await getMessaging(this.app).send({
        token,
        data,
        android: { priority: "high", ttl: ttlSec * 1000 },
        webpush: { headers: { Urgency: "high", TTL: String(ttlSec) } },
      });
      return { ok: true, invalidToken: false };
    } catch (err: unknown) {
      return this.failure(err);
    }
  }

  private failure(err: unknown): FcmSendResult {
    const code = (err as { code?: string })?.code ?? "";
    const invalidToken =
      code === "messaging/registration-token-not-registered" ||
      code === "messaging/invalid-registration-token" ||
      code === "messaging/invalid-argument";
    // No code at all is a network error: FCM was unreachable.
    const transient = !invalidToken && (!code || TRANSIENT_CODES.has(code));
    if (!invalidToken) {
      this.logger.warn(`FCM send failed: ${String(err)}`);
    }
    return { ok: false, invalidToken, transient };
  }

  private transientStreak = 0;
  private degradedSince: number | null = null;

  /** FCM is failing for now: message pushes queue instead of trying each time (see PushQueueService). */
  get isDegraded(): boolean {
    return this.degradedSince !== null;
  }

  private markHealthy(): void {
    this.transientStreak = 0;
    if (this.degradedSince !== null) {
      this.logger.log(
        `FCM reachable again after ${Math.round((Date.now() - this.degradedSince) / 1000)}s`,
      );
      this.degradedSince = null;
    }
  }

  private noteResult(result: FcmSendResult): FcmSendResult {
    if (result.ok) this.markHealthy();
    else if (result.transient) {
      this.transientStreak += 1;
      if (
        this.transientStreak >= DEGRADED_AFTER &&
        this.degradedSince === null
      ) {
        this.degradedSince = Date.now();
        this.logger.warn(
          "FCM looks down — message pushes are queued until it answers again",
        );
      }
    }
    return result;
  }

  /**
   * A dry-run send to a made-up token. FCM answers "invalid argument" when it's up (it checked the
   * request and rejected only the token); a server error means it's still down. Returns reachable.
   */
  async probe(): Promise<boolean> {
    if (!this.app) return false;
    try {
      await getMessaging(this.app).send(
        {
          token: "probe-token",
          notification: { title: "probe", body: "probe" },
        },
        true,
      );
    } catch (err: unknown) {
      const result = this.failure(err);
      if (result.transient) return false;
    }
    this.markHealthy();
    return true;
  }

  /**
   * A message push: the browser shows `notification` itself. `web.tag` replaces the previous
   * notification of the same chat (instead of stacking), and `web.link` is where a tap opens.
   */
  async send(
    token: string,
    notification: { title: string; body: string },
    data: Record<string, string>,
    web?: { tag?: string; link?: string },
  ): Promise<FcmSendResult> {
    if (!this.app) return { ok: false, invalidToken: false };
    try {
      await getMessaging(this.app).send({
        token,
        notification,
        data,
        webpush: {
          notification: {
            tag: web?.tag,
            renotify: !!web?.tag,
            icon: "/icons/icon-192.png",
            badge: "/icons/badge-96.png",
          },
          fcmOptions: web?.link ? { link: web.link } : undefined,
        },
      });
      return this.noteResult({ ok: true, invalidToken: false });
    } catch (err: unknown) {
      return this.noteResult(this.failure(err));
    }
  }
}
