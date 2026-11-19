/** Pure helpers for the call screen — no LiveKit or React imports, so they're
 * cheap to unit-test (call-utils.test.ts). */

export function formatDuration(totalSeconds: number): string {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  const ss = s.toString().padStart(2, "0");
  return h > 0 ? `${h}:${m.toString().padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/** LiveKit participant metadata is a free-form string; the backend puts
 * `{"photo": "<url>"|null}` in it (calls.service.ts `participantMetadata`).
 * Anything else (older tokens, garbage) just means "no photo". */
export function parseParticipantMeta(metadata: string | undefined | null): { photo: string | null } {
  if (!metadata) return { photo: null };
  try {
    const parsed: unknown = JSON.parse(metadata);
    if (parsed && typeof parsed === "object" && "photo" in parsed) {
      const photo = (parsed as { photo: unknown }).photo;
      return { photo: typeof photo === "string" && photo ? photo : null };
    }
  } catch {
    /* not JSON */
  }
  return { photo: null };
}

export interface GridShape {
  cols: number;
  /** Rows that share the stage height equally; null = too many tiles to fit,
   * rows get a fixed aspect ratio and the grid scrolls. */
  rows: number | null;
}

/** Tiles per row/column for the participant grid, adapting to the count and
 * the stage's orientation: 1–2 big, 3 in a row (2×2 in portrait), 4 as 2×2, 5–6 as 3×2 (2×3 in
 * portrait), anything more scrolls. */
export function gridShape(count: number, portrait: boolean, wide = false): GridShape {
  if (count <= 1) return { cols: 1, rows: 1 };
  if (count === 2) return portrait ? { cols: 1, rows: 2 } : { cols: 2, rows: 1 };
  if (count === 3 && !portrait) return { cols: 3, rows: 1 };
  if (count <= 4) return { cols: 2, rows: 2 };
  if (count <= 6) return portrait ? { cols: 2, rows: 3 } : { cols: 3, rows: 2 };
  if (portrait) return { cols: 2, rows: null };
  if (count <= 9 && wide) return { cols: 3, rows: 3 };
  return { cols: wide ? 4 : 3, rows: null };
}

export type CallLayout = "waiting" | "grid" | "spotlight" | "duo";

export interface LayoutInput {
  /** Every tile key currently on stage (cameras + screen shares). */
  tileKeys: string[];
  participantCount: number;
  /** A screen-share tile key, if anyone is sharing. */
  screenShareKey: string | null;
  /** Tile the user explicitly spotlighted (may have since left). */
  focusKey: string | null;
  anyCameraOn: boolean;
  /** The user asked for the plain grid (overrides auto spotlight/duo). */
  preferGrid: boolean;
}

/** Which arrangement the stage uses, and which tile (if any) is the big one. */
export function pickLayout(input: LayoutInput): { layout: CallLayout; focusKey: string | null } {
  const { tileKeys, participantCount, screenShareKey, focusKey, anyCameraOn, preferGrid } = input;
  if (participantCount <= 1 && !screenShareKey) return { layout: "waiting", focusKey: null };
  if (focusKey && tileKeys.includes(focusKey)) return { layout: "spotlight", focusKey };
  if (preferGrid) return { layout: "grid", focusKey: null };
  if (screenShareKey) return { layout: "spotlight", focusKey: screenShareKey };
  if (participantCount === 2 && anyCameraOn) return { layout: "duo", focusKey: null };
  return { layout: "grid", focusKey: null };
}

export type Corner = "top-start" | "top-end" | "bottom-start" | "bottom-end";

/** Nearest corner of a `w`×`h` box to the point (x, y) — where a dragged
 * self-view / mini call card snaps to on release. Physical (left/right)
 * coordinates in, logical corner out, so RTL mirrors it. */
export function nearestCorner(x: number, y: number, w: number, h: number, rtl = false): Corner {
  const left = x < w / 2;
  const top = y < h / 2;
  const start = rtl ? !left : left;
  return `${top ? "top" : "bottom"}-${start ? "start" : "end"}` as Corner;
}

/** Friendly fallback labels for devices the browser hasn't named yet
 * (labels stay empty until permission for that kind is granted). */
export function deviceLabel(device: { label: string; deviceId: string }, kind: MediaDeviceKind, index: number): string {
  const label = device.label.trim();
  if (label) return label.replace(/\s*\([0-9a-f]{4}:[0-9a-f]{4}\)$/i, "");
  if (device.deviceId === "default") return "System default";
  const noun = kind === "audioinput" ? "Microphone" : kind === "videoinput" ? "Camera" : "Speaker";
  return `${noun} ${index + 1}`;
}

export interface VideoStatsSample {
  width: number;
  height: number;
  fps: number;
  bytes: number;
  /** ms */
  timestamp: number;
  codec: string | null;
}

type StatsEntry = Record<string, unknown> & { type?: string; id?: string };
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** Summarise a video track's `getStats()` report: the resolution/fps of the
 * best layer actually flowing (simulcast publishes several outbound
 * entries), total bytes so far, and the codec. */
export function readVideoStats(entries: Iterable<StatsEntry>, direction: "inbound" | "outbound"): VideoStatsSample | null {
  const all = Array.from(entries);
  const rtp = all.filter((e) => e.type === `${direction}-rtp` && (e.kind === "video" || e.mediaType === "video"));
  if (rtp.length === 0) return null;
  const top = rtp.reduce((best, e) => (num(e.frameWidth) > num(best.frameWidth) ? e : best), rtp[0]);
  const codecEntry = all.find((e) => e.type === "codec" && e.id === top.codecId);
  const mime = typeof codecEntry?.mimeType === "string" ? codecEntry.mimeType : null;
  return {
    width: num(top.frameWidth),
    height: num(top.frameHeight),
    fps: Math.round(num(top.framesPerSecond)),
    bytes: rtp.reduce((sum, e) => sum + num(direction === "inbound" ? e.bytesReceived : e.bytesSent), 0),
    timestamp: Math.max(...rtp.map((e) => num(e.timestamp))),
    codec: mime ? mime.replace(/^video\//i, "").toUpperCase() : null,
  };
}

/** "1280×720 · 30 fps · 1.4 Mbps · VP8" (bitrate needs a previous sample). */
export function formatVideoStats(cur: VideoStatsSample, prev: VideoStatsSample | null): string {
  const parts: string[] = [];
  if (cur.width && cur.height) parts.push(`${cur.width}×${cur.height}`);
  if (cur.fps) parts.push(`${cur.fps} fps`);
  if (prev && cur.timestamp > prev.timestamp && cur.bytes >= prev.bytes) {
    const bps = ((cur.bytes - prev.bytes) * 8 * 1000) / (cur.timestamp - prev.timestamp);
    parts.push(bps >= 1_000_000 ? `${(bps / 1_000_000).toFixed(1)} Mbps` : `${Math.round(bps / 1000)} kbps`);
  }
  if (cur.codec) parts.push(cur.codec);
  return parts.join(" · ");
}

// ---------------------------------------------------------------------------
// Camera quality: levels, encodings, and the "Auto" (network-driven) stepper.

/** Camera send levels, named by the short side of the picture (portrait
 * phones too: "720p" is 720×1280 there). */
export type SendLevel = 1080 | 720 | 480 | 360;
export type SendPref = "auto" | SendLevel;
export const SEND_LEVELS: readonly SendLevel[] = [1080, 720, 480, 360];

const lower = (l: SendLevel): SendLevel => SEND_LEVELS[Math.min(SEND_LEVELS.length - 1, SEND_LEVELS.indexOf(l) + 1)];
const higher = (l: SendLevel): SendLevel => SEND_LEVELS[Math.max(0, SEND_LEVELS.indexOf(l) - 1)];

/** Target bitrate for one VP8 layer at 30 fps, by its short side: 720 →
 * 1.7 Mbps, 1080 → ~3.3 Mbps, 480 → ~890 kbps, 360 → ~560 kbps, 180 → ~185 kbps. */
export function bitrateForHeight(h: number): number {
  return Math.max(60_000, Math.round((1_700_000 * Math.pow(h / 720, 1.6)) / 10_000) * 10_000);
}

/** What all three simulcast layers of a level need together. */
export function levelNeed(level: number): number {
  return bitrateForHeight(level) + bitrateForHeight(level / 2) + bitrateForHeight(level / 4);
}

/** Encoder settings for the simulcast layers (index 0 = top layer) when the
 * camera captures at short side `captured` and we want the top layer at
 * `level`: the top is `level` (or the capture, if smaller), each lower layer
 * half the one above. */
export function layerPlan(captured: number, level: number, count: number): { scaleResolutionDownBy: number; maxBitrate: number }[] {
  const top = Math.min(level, captured);
  return Array.from({ length: count }, (_, i) => {
    const h = top / 2 ** i;
    return { scaleResolutionDownBy: Math.max(1, captured / h), maxBitrate: bitrateForHeight(h) };
  });
}

/** First guess before any stats exist, from the Network Information API
 * (Chromium only — elsewhere we start at 720p and let the stepper decide). */
export function startLevel(conn?: { effectiveType?: string; downlink?: number; saveData?: boolean } | null): SendLevel {
  if (!conn) return 720;
  if (conn.saveData) return 360;
  switch (conn.effectiveType) {
    case "slow-2g":
    case "2g":
      return 360;
    case "3g":
      return 480;
  }
  // `downlink` (Mbps) is a rough, download-side estimate from recent page
  // traffic, so only a clearly slow value lowers the start; the stepper
  // takes it up from there within ~30 s if the uplink allows.
  if (typeof conn.downlink === "number" && conn.downlink > 0 && conn.downlink < 1) return 480;
  return 720;
}

export interface SendHealth {
  /** The browser's estimate of the uplink (bps), when it reports one. */
  availableBps: number | null;
  /** Fraction of packets lost on the way to the server (0–1). */
  loss: number | null;
  rttMs: number | null;
  /** Why the encoder can't reach its target on the active layers. */
  limitation: "none" | "bandwidth" | "cpu";
  /** LiveKit's own connection quality says poor/lost. */
  poor: boolean;
}

type Stat = Record<string, unknown> & { type?: string };
const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** Summarise a camera sender's `getStats()` report. */
export function readSendHealth(entries: Iterable<Stat>, poor = false): SendHealth {
  let limitation: SendHealth["limitation"] = "none";
  let loss: number | null = null;
  let rtt: number | null = null;
  let available: number | null = null;
  for (const e of entries) {
    const video = e.kind === "video" || e.mediaType === "video";
    if (e.type === "outbound-rtp" && video && e.active !== false) {
      if (e.qualityLimitationReason === "cpu") limitation = "cpu";
      else if (e.qualityLimitationReason === "bandwidth" && limitation === "none") limitation = "bandwidth";
    } else if (e.type === "remote-inbound-rtp" && video) {
      const fl = n(e.fractionLost);
      if (fl !== null) loss = Math.max(loss ?? 0, fl);
      const r = n(e.roundTripTime);
      if (r !== null) rtt = Math.max(rtt ?? 0, r * 1000);
    } else if (e.type === "candidate-pair" && (e.nominated || e.selected) && e.state === "succeeded") {
      const a = n(e.availableOutgoingBitrate);
      if (a !== null) available = Math.max(available ?? 0, a);
    }
  }
  return { availableBps: available, loss, rttMs: rtt, limitation, poor };
}

export interface AutoState {
  level: SendLevel;
  /** When the level last changed — decisions wait out the ramp-up after it. */
  changedAt: number;
  badSince: number | null;
  goodSince: number | null;
  /** When we last stepped up (to tell a failed upgrade from a later drop). */
  upAt: number | null;
  /** A level we just had to leave can't be retried until then. */
  blockedUntil: Partial<Record<SendLevel, number>>;
  backoff: Partial<Record<SendLevel, number>>;
  /** Right after the camera starts, WebRTC's bandwidth estimate is still
   * ramping up from a few hundred kbps and the encoder reports itself
   * "bandwidth-limited" — that isn't a slow network, so it's ignored. */
  rampUntil: number;
}

export const AUTO_TIMING = { grace: 8_000, ramp: 20_000, downAfter: 5_000, upAfter: 20_000, backoff: 30_000, maxBackoff: 300_000, failedUpWindow: 180_000 };

export function initialAutoState(level: SendLevel, now: number): AutoState {
  return { level, changedAt: now, badSince: null, goodSince: null, upAt: null, blockedUntil: {}, backoff: {}, rampUntil: now + AUTO_TIMING.ramp };
}

/** One tick of the Auto stepper (every ~2 s). Downgrades after ~5 s of
 * trouble (straight to the level the measured uplink can carry), upgrades
 * one step after ~20 s of headroom, and won't retry a level it just failed
 * at for 30 s → 1 min → 2 min … (max 5), so it never flaps. */
export function autoStep(s: AutoState, h: SendHealth, now: number, max: SendLevel): AutoState {
  const T = AUTO_TIMING;
  if (s.level > max) return { ...s, level: max, changedAt: now, badSince: null, goodSince: null };
  if (now - s.changedAt < T.grace) return { ...s, badSince: null, goodSince: null };
  const need = levelNeed(s.level);
  const ramping = now < s.rampUntil;
  const bad = h.poor || h.limitation === "cpu" || (h.limitation === "bandwidth" && !ramping) || (h.loss ?? 0) > 0.08;
  const good = !bad && (h.loss ?? 0) < 0.02 && (h.availableBps === null || h.availableBps >= need * 0.9);
  const badSince = bad ? (s.badSince ?? now) : null;
  const goodSince = good ? (s.goodSince ?? now) : null;

  if (badSince !== null && now - badSince >= T.downAfter && s.level > SEND_LEVELS[SEND_LEVELS.length - 1]) {
    let target = lower(s.level);
    if (h.availableBps !== null) {
      while (target > 360 && levelNeed(target) > h.availableBps * 0.85) target = lower(target);
    }
    const failedUp = s.upAt !== null && now - s.upAt < T.failedUpWindow;
    const wait = failedUp ? Math.min(T.maxBackoff, Math.max(T.backoff, (s.backoff[s.level] ?? 0) * 2)) : T.backoff;
    return {
      ...s,
      level: target,
      changedAt: now,
      badSince: null,
      goodSince: null,
      upAt: null,
      backoff: { ...s.backoff, [s.level]: wait },
      blockedUntil: { ...s.blockedUntil, [s.level]: now + wait },
    };
  }
  if (goodSince !== null && now - goodSince >= T.upAfter && s.level < max) {
    const up = higher(s.level);
    if ((s.blockedUntil[up] ?? 0) <= now) return { ...s, level: up, changedAt: now, badSince: null, goodSince: null, upAt: now };
  }
  return { ...s, badSince, goodSince };
}

/** Receiving side of Auto: cap everyone's video when *our* connection is
 * weak — Medium when poor, Low when lost — after ~4 s, and lift the cap
 * after ~15 s of a good connection. */
export type RecvCap = "none" | "medium" | "low";
export interface RecvCapState {
  cap: RecvCap;
  badSince: number | null;
  goodSince: number | null;
}
export function recvCapStep(s: RecvCapState, quality: "excellent" | "good" | "poor" | "lost" | "unknown", now: number): RecvCapState {
  const want: RecvCap = quality === "lost" ? "low" : quality === "poor" ? "medium" : "none";
  const rank = { none: 0, medium: 1, low: 2 } as const;
  if (rank[want] > rank[s.cap]) {
    const badSince = s.badSince ?? now;
    return now - badSince >= 4_000 ? { cap: want, badSince: null, goodSince: null } : { ...s, badSince, goodSince: null };
  }
  if (want === "none" && quality !== "unknown" && s.cap !== "none") {
    const goodSince = s.goodSince ?? now;
    return now - goodSince >= 15_000 ? { cap: "none", badSince: null, goodSince: null } : { ...s, goodSince, badSince: null };
  }
  return { ...s, badSince: null, goodSince: null };
}
