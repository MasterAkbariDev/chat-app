import { Injectable, ServiceUnavailableException } from "@nestjs/common";
import { AccessToken, RoomServiceClient } from "livekit-server-sdk";

/**
 * Generates LiveKit room-join JWTs (B8, docs/plans/BACKEND_PLAN.md). Self-hosted: the API
 * key/secret pair isn't obtained from anywhere external — they're generated once and configured
 * identically on the LiveKit server (`livekit.yaml`) and here (`LIVEKIT_API_KEY`/
 * `LIVEKIT_API_SECRET`), matching values on both sides is what makes a token valid.
 */
@Injectable()
export class LiveKitTokenService {
  private get apiKey(): string {
    const key = process.env.LIVEKIT_API_KEY;
    if (!key) {
      throw new ServiceUnavailableException(
        "LIVEKIT_API_KEY is not configured — calls are unavailable",
      );
    }
    return key;
  }

  private get apiSecret(): string {
    const secret = process.env.LIVEKIT_API_SECRET;
    if (!secret) {
      throw new ServiceUnavailableException(
        "LIVEKIT_API_SECRET is not configured — calls are unavailable",
      );
    }
    return secret;
  }

  get livekitUrl(): string {
    const url = process.env.LIVEKIT_URL;
    if (!url) {
      throw new ServiceUnavailableException(
        "LIVEKIT_URL is not configured — calls are unavailable",
      );
    }
    return url;
  }

  private roomService: RoomServiceClient | null = null;

  /** Identities currently connected to `roomName` per the LiveKit server — the ground truth
   *  for "who is actually in this call" (a client that crashed never calls /leave). `[]` when
   *  the room doesn't exist (nobody ever connected, or everyone left); `null` when LiveKit
   *  can't be asked (not configured / unreachable) — callers then leave state alone. */
  async listParticipantIdentities(roomName: string): Promise<string[] | null> {
    const url = process.env.LIVEKIT_INTERNAL_URL || process.env.LIVEKIT_URL;
    const key = process.env.LIVEKIT_API_KEY;
    const secret = process.env.LIVEKIT_API_SECRET;
    if (!url || !key || !secret) return null;
    try {
      this.roomService ??= new RoomServiceClient(
        url.replace(/^ws/, "http"),
        key,
        secret,
      );
      const participants = await this.roomService.listParticipants(roomName);
      return participants.map(p => p.identity);
    } catch (err) {
      const e = err as { code?: string };
      if (e?.code === "not_found") return [];
      return null;
    }
  }

  /** A short-lived token scoped to exactly one room, for exactly one participant identity —
   *  never a room-admin/room-create grant, since the caller only ever needs to join. */
  async createRoomToken(
    roomName: string,
    identity: string,
    name: string,
    metadata?: string,
  ): Promise<string> {
    const token = new AccessToken(this.apiKey, this.apiSecret, {
      identity,
      name,
      metadata,
      ttl: "10m",
    });
    token.addGrant({
      room: roomName,
      roomJoin: true,
      canPublish: true,
      canSubscribe: true,
    });
    return token.toJwt();
  }
}
