import { Injectable, Logger } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { Model } from "mongoose";
import { Cron, CronExpression } from "@nestjs/schedule";
import { MediaAsset } from "./schema/media-asset.schema";

const DEFAULT_COLD_TIER_DAYS = 90;

export interface TieringResult {
  scanned: number;
  taggedCold: number;
}

export interface OrphanReport {
  count: number;
  totalBytes: number;
  sampleIds: string[];
}

/**
 * Nightly media housekeeping (B11, docs/plans/BACKEND_PLAN.md):
 *  - lifecycle tiering: tags assets untouched for `MEDIA_COLD_TIER_DAYS` days `cold` — never
 *    deletes, never changes how they're served (see `MediaAsset.tier`'s own doc comment for why
 *    this is metadata-only on self-hosted MinIO rather than a real storage-class transition).
 *  - orphan sweep: reports (never deletes — "archive, don't delete", Q7) `MediaAsset` rows
 *    whose `refCount` has reached 0. An admin can hard-delete a specific one from the panel
 *    (`AdminMediaController`) — this job only surfaces candidates, it never acts on them.
 */
@Injectable()
export class MediaMaintenanceService {
  private readonly logger = new Logger(MediaMaintenanceService.name);

  constructor(
    @InjectModel(MediaAsset.name) private mediaAssetModel: Model<MediaAsset>,
  ) {}

  @Cron(CronExpression.EVERY_DAY_AT_1AM)
  async runTiering(): Promise<TieringResult> {
    const coldTierDays = Number(
      process.env.MEDIA_COLD_TIER_DAYS ?? DEFAULT_COLD_TIER_DAYS,
    );
    const cutoff = new Date(Date.now() - coldTierDays * 24 * 60 * 60 * 1000);

    const scanned = await this.mediaAssetModel.countDocuments({}).exec();
    const result = await this.mediaAssetModel
      .updateMany(
        { tier: "hot", lastAccessedAt: { $lt: cutoff } },
        { $set: { tier: "cold" } },
      )
      .exec();

    const taggedCold = result.modifiedCount;
    this.logger.log(
      `Media tiering: scanned ${scanned}, tagged ${taggedCold} cold (untouched ${coldTierDays}+ days)`,
    );
    return { scanned, taggedCold };
  }

  @Cron(CronExpression.EVERY_DAY_AT_2AM)
  async runOrphanReport(): Promise<OrphanReport> {
    const orphans = await this.mediaAssetModel
      .find({ refCount: { $lte: 0 } })
      .select("_id sizeBytes")
      .lean()
      .exec();

    const totalBytes = orphans.reduce((sum, o) => sum + o.sizeBytes, 0);
    const report: OrphanReport = {
      count: orphans.length,
      totalBytes,
      sampleIds: orphans.slice(0, 20).map(o => o._id.toString()),
    };
    this.logger.log(
      `Media orphan report: ${report.count} asset(s) at refCount 0, ` +
        `${report.totalBytes} bytes total — archived, not deleted. ` +
        `An admin can hard-delete individually via DELETE /v1/admin/media/:id.`,
    );
    return report;
  }
}
