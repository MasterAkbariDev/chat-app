import { Injectable, NotFoundException } from "@nestjs/common";
import { existsSync, createReadStream, promises as fs } from "fs";
import { dirname, join } from "path";
import {
  MediaByteRange,
  MediaStorage,
  MediaStreamResult,
} from "./media-storage.interface";

/** Default implementation: writes under `uploads/media/<relativePath>`. Swapped for
 *  S3MediaStorageService when MEDIA_STORAGE_DRIVER=s3 (B11). */
@Injectable()
export class DiskMediaStorageService implements MediaStorage {
  // Overridable so tests can point at an isolated temp directory instead of the real uploads/.
  private readonly root =
    process.env.MEDIA_STORAGE_ROOT ?? join(process.cwd(), "uploads", "media");

  async put(relativePath: string, data: Buffer): Promise<void> {
    const fullPath = join(this.root, relativePath);
    await fs.mkdir(dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, data);
  }

  exists(relativePath: string): Promise<boolean> {
    return Promise.resolve(existsSync(join(this.root, relativePath)));
  }

  async getStream(
    relativePath: string,
    range?: MediaByteRange,
  ): Promise<MediaStreamResult> {
    const fullPath = join(this.root, relativePath);
    let sizeBytes: number;
    try {
      sizeBytes = (await fs.stat(fullPath)).size;
    } catch {
      throw new NotFoundException("Media file not found");
    }
    const stream = createReadStream(
      fullPath,
      range ? { start: range.start, end: range.end } : undefined,
    );
    return { stream, sizeBytes };
  }

  async deleteAll(hashPrefix: string): Promise<void> {
    await fs.rm(join(this.root, hashPrefix), { recursive: true, force: true });
  }
}
