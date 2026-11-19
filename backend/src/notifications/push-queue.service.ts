import { Injectable, Logger } from "@nestjs/common";
import { Interval } from "@nestjs/schedule";
import { InjectModel } from "@nestjs/mongoose";
import { Model } from "mongoose";
import { FcmService } from "./fcm.service";
import { PendingPush } from "./schema/pending-push.schema";

/** A message push is kept this long, then dropped (2 days). */
const QUEUE_TTL_MS = 2 * 24 * 60 * 60 * 1000;
/** Retry backoff: 30 s, doubling, capped at 30 min. */
const MAX_BACKOFF_MS = 30 * 60 * 1000;
const BASE_BACKOFF_MS = 30 * 1000;
const BATCH = 200;

export interface QueuedPush {
  token: string;
  userId: string;
  notification: { title: string; body: string };
  data: Record<string, string>;
  web?: { tag?: string; link?: string };
}

/**
 * Message pushes FCM couldn't take. Stored, then sent again on a backoff once FCM answers (a probe
 * tells us while it's degraded). Nothing is shown to users about it: they get the notification late,
 * and the message itself is there when they open the app.
 */
@Injectable()
export class PushQueueService {
  private readonly logger = new Logger(PushQueueService.name);
  private draining = false;

  constructor(
    @InjectModel(PendingPush.name)
    private readonly pendingModel: Model<PendingPush>,
    private readonly fcm: FcmService,
  ) {}

  async enqueue(items: QueuedPush[]): Promise<void> {
    if (!items.length) return;
    const now = Date.now();
    await this.pendingModel.insertMany(
      items.map(item => ({
        ...item,
        web: item.web ?? null,
        attempts: 0,
        nextAttemptAt: new Date(now),
        expiresAt: new Date(now + QUEUE_TTL_MS),
      })),
    );
  }

  /** Every 30 s: if FCM is degraded, probe it first; then send what's due, oldest first. */
  @Interval(30_000)
  async drain(): Promise<void> {
    if (this.draining || !this.fcm.isConfigured) return;
    this.draining = true;
    try {
      if (this.fcm.isDegraded && !(await this.fcm.probe())) return;
      const due = await this.pendingModel
        .find({ nextAttemptAt: { $lte: new Date() } })
        .sort({ nextAttemptAt: 1 })
        .limit(BATCH)
        .lean()
        .exec();
      for (const p of due) {
        const result = await this.fcm.send(
          p.token,
          p.notification,
          p.data,
          p.web ?? undefined,
        );
        if (result.ok || result.invalidToken || !result.transient) {
          await this.pendingModel.deleteOne({ _id: p._id }).exec();
        } else {
          const attempts = (p.attempts ?? 0) + 1;
          const backoff = Math.min(
            MAX_BACKOFF_MS,
            BASE_BACKOFF_MS * 2 ** attempts,
          );
          await this.pendingModel
            .updateOne(
              { _id: p._id },
              {
                $set: {
                  attempts,
                  nextAttemptAt: new Date(Date.now() + backoff),
                },
              },
            )
            .exec();
        }
        // FCM went down again mid-batch: leave the rest for the next round.
        if (this.fcm.isDegraded) break;
      }
    } catch (err) {
      this.logger.warn(`push queue drain failed: ${String(err)}`);
    } finally {
      this.draining = false;
    }
  }
}
