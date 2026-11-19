import { Injectable, ServiceUnavailableException } from "@nestjs/common";
import axios from "axios";

export type GiphyKind = "gif" | "sticker";

export interface GiphyItem {
  id: string;
  title: string;
  /** Full-quality asset to mirror into our own storage on first use. */
  originalUrl: string;
  /** Small, fast-loading preview for a search/trending grid — never mirrored itself. */
  previewUrl: string;
}

interface GiphyImageRendition {
  url: string;
}

interface GiphyApiObject {
  id: string;
  title?: string;
  images: {
    original?: GiphyImageRendition;
    fixed_width?: GiphyImageRendition;
    fixed_width_small?: GiphyImageRendition;
  };
}

interface GiphyListResponse {
  data: GiphyApiObject[];
}

interface GiphyGetResponse {
  data: GiphyApiObject;
}

const GIPHY_BASE_URL = "https://api.giphy.com/v1";

/**
 * Thin client for the Giphy REST API (B9, docs/plans/BACKEND_PLAN.md — replaces Tenor, which
 * froze new signups 2026-01-14 and fully shut down 2026-06-30). Only talks to Giphy; caching a
 * fetched asset into our own storage is `GiphyService`'s job, not this class's.
 */
@Injectable()
export class GiphyClientService {
  private get apiKey(): string {
    const key = process.env.GIPHY_API_KEY;
    if (!key) {
      throw new ServiceUnavailableException(
        "GIPHY_API_KEY is not configured — the global GIF/sticker tab is unavailable",
      );
    }
    return key;
  }

  private toItem(obj: GiphyApiObject): GiphyItem {
    return {
      id: obj.id,
      title: obj.title ?? "",
      originalUrl: obj.images.original?.url ?? "",
      previewUrl:
        obj.images.fixed_width_small?.url ??
        obj.images.fixed_width?.url ??
        obj.images.original?.url ??
        "",
    };
  }

  async search(
    kind: GiphyKind,
    query: string,
    limit: number,
    offset: number,
  ): Promise<GiphyItem[]> {
    const endpoint = kind === "sticker" ? "stickers" : "gifs";
    const { data } = await axios.get<GiphyListResponse>(
      `${GIPHY_BASE_URL}/${endpoint}/search`,
      { params: { api_key: this.apiKey, q: query, limit, offset } },
    );
    return data.data.map(item => this.toItem(item));
  }

  async trending(
    kind: GiphyKind,
    limit: number,
    offset: number,
  ): Promise<GiphyItem[]> {
    const endpoint = kind === "sticker" ? "stickers" : "gifs";
    const { data } = await axios.get<GiphyListResponse>(
      `${GIPHY_BASE_URL}/${endpoint}/trending`,
      { params: { api_key: this.apiKey, limit, offset } },
    );
    return data.data.map(item => this.toItem(item));
  }

  async getById(_kind: GiphyKind, giphyId: string): Promise<GiphyItem> {
    // Giphy has no `/v1/stickers/{id}` — stickers and gifs share one object/id namespace, and
    // the single-item lookup only ever exists under `/v1/gifs/{id}` (confirmed against the
    // real API: a sticker id returned `{"type":"sticker", ...}` from that same endpoint).
    // `search`/`trending` are the only two Giphy endpoints that actually differ by kind.
    const { data } = await axios.get<GiphyGetResponse>(
      `${GIPHY_BASE_URL}/gifs/${giphyId}`,
      { params: { api_key: this.apiKey } },
    );
    return this.toItem(data.data);
  }

  /** Downloads the actual asset bytes so they can be handed to `MediaService.ingestImage`. */
  async fetchBytes(url: string): Promise<Buffer> {
    const { data } = await axios.get<ArrayBuffer>(url, {
      responseType: "arraybuffer",
    });
    return Buffer.from(data);
  }
}
