"use client";

// Same "no shipped audio asset" reasoning as NotificationsHost's
// `playNotificationSound` — a two-tone ring synthesized with Web Audio.
//
// Why it used to be silent "sometimes":
// - A fresh AudioContext created when a ring arrives starts *suspended*
//   unless the tab has had a user gesture since — so a ring in a tab you
//   hadn't touched yet played nothing. Now one context is created and
//   resumed on the first gesture (`primeRingtone`) and reused for every ring.
// - The ring was re-triggered by `setInterval`, which background tabs
//   throttle (to once a minute after a while). Now the 2 s pattern is one
//   pre-rendered buffer played with `loop = true` on the audio clock — it
//   keeps ringing in a background tab.
let ctx: AudioContext | null = null;
let buffer: AudioBuffer | null = null;
let source: AudioBufferSourceNode | null = null;
let primed = false;

function audioContextCtor(): typeof AudioContext | null {
  if (typeof window === "undefined") return null;
  return window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext || null;
}

function context(): AudioContext | null {
  if (ctx) return ctx;
  const Ctor = audioContextCtor();
  if (!Ctor) return null;
  try {
    ctx = new Ctor();
  } catch {
    ctx = null;
  }
  return ctx;
}

/** One 2-second ring cycle: 660 Hz then 880 Hz blips, then silence. */
export function renderRingSamples(sampleRate: number): Float32Array {
  const out = new Float32Array(Math.round(sampleRate * 2));
  [660, 880].forEach((freq, i) => {
    const start = Math.round((i * 0.16) * sampleRate);
    const len = Math.round(0.36 * sampleRate);
    for (let n = 0; n < len && start + n < out.length; n++) {
      const t = n / sampleRate;
      // 20 ms attack, exponential-ish decay — same envelope as before.
      const env = t < 0.02 ? (t / 0.02) * 0.16 : 0.16 * Math.exp(-(t - 0.02) * 14);
      out[start + n] += Math.sin(2 * Math.PI * freq * t) * env;
    }
  });
  return out;
}

function ringBuffer(c: AudioContext): AudioBuffer {
  if (buffer && buffer.sampleRate === c.sampleRate) return buffer;
  const samples = renderRingSamples(c.sampleRate);
  buffer = c.createBuffer(1, samples.length, c.sampleRate);
  buffer.getChannelData(0).set(samples);
  return buffer;
}

/** Unlocks audio on the first user gesture so a later ring is audible even
 * when it arrives with no gesture of its own (background tab, idle tab).
 * Safe to call repeatedly; mounted once by the call provider. */
export function primeRingtone() {
  if (primed || typeof window === "undefined") return;
  primed = true;
  const done = () => {
    window.removeEventListener("pointerdown", unlock, true);
    window.removeEventListener("keydown", unlock, true);
  };
  const unlock = () => {
    const c = context();
    if (!c) return done();
    // Resuming inside a gesture grants the page sticky activation; then park
    // the context (suspended) until a ring needs it.
    c.resume()
      .then(() => {
        if (!source) c.suspend().catch(() => {});
        done();
      })
      .catch(() => {});
  };
  window.addEventListener("pointerdown", unlock, true);
  window.addEventListener("keydown", unlock, true);
}

/** Idempotent — a second call while already ringing is a no-op. */
export function startRingtone() {
  if (source) return;
  const c = context();
  if (!c) return;
  try {
    if (c.state === "suspended") c.resume().catch(() => {});
    const node = c.createBufferSource();
    node.buffer = ringBuffer(c);
    node.loop = true;
    node.connect(c.destination);
    node.start();
    source = node;
  } catch {
    // Unsupported — the visible banner / system notification still shows.
  }
  try {
    navigator.vibrate?.([400, 200, 400, 1000]);
  } catch {
    // Not supported / no user activation yet.
  }
}

export function stopRingtone() {
  try {
    source?.stop();
  } catch {
    // Already stopped.
  }
  source?.disconnect();
  source = null;
  // Idle → suspended: a running context left open would keep a phone's audio
  // in "media" mode, which can pull a later call onto the loudspeaker.
  ctx?.suspend().catch(() => {});
  try {
    navigator.vibrate?.(0);
  } catch {
    // ignore
  }
}

export function isRinging() {
  return source !== null;
}
