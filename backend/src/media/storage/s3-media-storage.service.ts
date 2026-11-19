import { Injectable, NotFoundException } from "@nestjs/common";
import { Readable } from "stream";
import {
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  NoSuchKey,
  NotFound,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import {
  MediaByteRange,
  MediaStorage,
  MediaStreamResult,
} from "./media-storage.interface";

/**
 * S3-compatible storage (B11, docs/plans/BACKEND_PLAN.md — "switch MediaService's storage
 * interface to S3-compatible"). Talks to any S3-compatible endpoint via the AWS SDK — this app
 * runs it against a self-hosted MinIO container (docker-compose's `minio` service), not a cloud
 * account, matching the same self-hosted-over-external preference already applied to B8's
 * LiveKit/coturn. `forcePathStyle` is required for MinIO (and most non-AWS S3-compatible
 * stores) — virtual-hosted-style bucket addressing (`bucket.endpoint`) assumes a real DNS
 * wildcard AWS itself provides.
 */
@Injectable()
export class S3MediaStorageService implements MediaStorage {
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor() {
    const endpoint = process.env.S3_ENDPOINT;
    const bucket = process.env.S3_BUCKET;
    const accessKeyId = process.env.S3_ACCESS_KEY_ID;
    const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY;
    if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) {
      throw new Error(
        "MEDIA_STORAGE_DRIVER=s3 requires S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY_ID, and " +
          "S3_SECRET_ACCESS_KEY to be set.",
      );
    }
    this.bucket = bucket;
    this.client = new S3Client({
      endpoint,
      region: process.env.S3_REGION ?? "us-east-1", // MinIO ignores this but the SDK requires one
      forcePathStyle: true,
      credentials: { accessKeyId, secretAccessKey },
    });
  }

  async put(relativePath: string, data: Buffer): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: relativePath,
        Body: data,
      }),
    );
  }

  async exists(relativePath: string): Promise<boolean> {
    try {
      await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: relativePath }),
      );
      return true;
    } catch (err) {
      if (err instanceof NotFound) return false;
      throw err;
    }
  }

  async getStream(
    relativePath: string,
    range?: MediaByteRange,
  ): Promise<MediaStreamResult> {
    try {
      const result = await this.client.send(
        new GetObjectCommand({
          Bucket: this.bucket,
          Key: relativePath,
          Range: range ? `bytes=${range.start}-${range.end}` : undefined,
        }),
      );
      // `ContentRange` (e.g. "bytes 0-99/1234") is only present on a ranged response; its own
      // `ContentLength` there is just the partial length, not the total object size.
      const sizeBytes = result.ContentRange
        ? Number(result.ContentRange.split("/")[1])
        : (result.ContentLength ?? 0);
      return {
        stream: result.Body as Readable,
        sizeBytes,
      };
    } catch (err) {
      if (err instanceof NoSuchKey) {
        throw new NotFoundException("Media file not found");
      }
      throw err;
    }
  }

  async deleteAll(hashPrefix: string): Promise<void> {
    const listed = await this.client.send(
      new ListObjectsV2Command({
        Bucket: this.bucket,
        Prefix: `${hashPrefix}/`,
      }),
    );
    const keys = (listed.Contents ?? [])
      .map(obj => obj.Key)
      .filter((key): key is string => !!key);
    if (keys.length === 0) return;
    await this.client.send(
      new DeleteObjectsCommand({
        Bucket: this.bucket,
        Delete: { Objects: keys.map(Key => ({ Key })) },
      }),
    );
  }
}
