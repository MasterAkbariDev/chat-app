"use client";

import { useEffect } from "react";
import {
  RoomEvent,
  Track,
  type AudioProcessorOptions,
  type LocalAudioTrack,
  type Participant,
  type Room,
  type TrackProcessor,
} from "livekit-client";

/**
 * Stops the call hearing its own voices back through a screen share.
 *
 * The echo: the sharer's computer plays the other people's voices (the call's
 * remote audio) through its speakers. A share that captures *system* sound, or a
 * whole screen with sound, records those voices too, so the share's audio track
 * carries each listener's own voice a fraction of a second late. A shared *tab*
 * can't do this: the call tab itself is excluded from the picker
 * (`selfBrowserSurface: "exclude"`), and another tab doesn't play this call. So
 * the guard only acts when the shared surface is not a browser tab.
 *
 * Mechanism: the captured share audio goes through a Web Audio gain before it is
 * published (LiveKit's track processor, so the captured track itself is never
 * stopped), and the gain is pulled down while anyone else in the call is
 * speaking, then released after a short hold. The sharer's own copy on their
 * device is untouched (the share's `<audio>`/tab playback is separate).
 */
export const ECHO_DUCK_GAIN = 0.05;
/** Keep the share ducked this long after the last remote voice, so a pause between words doesn't let an echo through. */
export const ECHO_RELEASE_HOLD_MS = 600;

type AudioCtor = typeof AudioContext;

export class ShareEchoGuard implements TrackProcessor<Track.Kind.Audio, AudioProcessorOptions> {
  readonly name = "share-echo-guard";
  processedTrack?: MediaStreamTrack;
  private ctx: AudioContext | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private gain: GainNode | null = null;
  private dest: MediaStreamAudioDestinationNode | null = null;
  private ducked = false;

  async init(opts: AudioProcessorOptions): Promise<void> {
    // Its own context, not the call's: nothing is connected to the speakers, so
    // this graph can't change how the phone routes sound.
    const Ctor = (window.AudioContext || (window as unknown as { webkitAudioContext: AudioCtor }).webkitAudioContext) as AudioCtor;
    this.ctx = new Ctor({ latencyHint: "playback" });
    this.dest = this.ctx.createMediaStreamDestination();
    this.gain = this.ctx.createGain();
    this.gain.gain.value = this.ducked ? ECHO_DUCK_GAIN : 1;
    this.gain.connect(this.dest);
    this.processedTrack = this.dest.stream.getAudioTracks()[0];
    this.connect(opts.track);
    await this.ctx.resume().catch(() => {});
  }

  async restart(opts: AudioProcessorOptions): Promise<void> {
    // The captured track was replaced (e.g. after a reconnect): keep the same output track.
    this.source?.disconnect();
    this.connect(opts.track);
  }

  async destroy(): Promise<void> {
    try {
      this.source?.disconnect();
      this.gain?.disconnect();
      this.processedTrack?.stop();
      await this.ctx?.close();
    } catch {
      /* already closed */
    }
    this.source = null;
    this.gain = null;
    this.dest = null;
    this.ctx = null;
    this.processedTrack = undefined;
  }

  /** Pull the shared sound down (or back up) without a click. */
  setDucked(on: boolean): void {
    this.ducked = on;
    if (!this.ctx || !this.gain) return;
    this.gain.gain.setTargetAtTime(on ? ECHO_DUCK_GAIN : 1, this.ctx.currentTime, on ? 0.02 : 0.2);
  }

  private connect(track: MediaStreamTrack) {
    if (!this.ctx || !this.gain) return;
    this.source = this.ctx.createMediaStreamSource(new MediaStream([track]));
    this.source.connect(this.gain);
  }
}

/** The shared surface: "browser" (a tab), "window" or "monitor" (screen / system sound). */
function shareSurface(room: Room): string | undefined {
  const video = room.localParticipant.getTrackPublication(Track.Source.ScreenShare)?.track;
  return video?.mediaStreamTrack?.getSettings().displaySurface;
}

/**
 * Sharer side: while a screen share with sound (not a single tab) is live,
 * duck the published sound whenever someone else in the call is talking.
 */
export function useShareEchoGuard(room: Room): void {
  useEffect(() => {
    let alive = true;
    let guard: ShareEchoGuard | null = null;
    let audio: LocalAudioTrack | null = null;
    let hold: ReturnType<typeof setTimeout> | null = null;
    let remoteTalking = room.activeSpeakers.some((p: Participant) => !p.isLocal);

    const duck = (on: boolean) => {
      if (hold) clearTimeout(hold);
      hold = null;
      guard?.setDucked(on);
    };

    const onSpeakers = (speakers: Participant[]) => {
      const talking = speakers.some((p) => !p.isLocal);
      if (talking === remoteTalking) return;
      remoteTalking = talking;
      if (talking) duck(true);
      else if (!hold) hold = setTimeout(() => duck(false), ECHO_RELEASE_HOLD_MS);
    };

    const attach = async () => {
      if (!alive || guard) return;
      const pub = room.localParticipant.getTrackPublication(Track.Source.ScreenShareAudio);
      const track = pub?.audioTrack;
      if (!track) return;
      if (shareSurface(room) === "browser") return;
      const next = new ShareEchoGuard();
      try {
        await track.setProcessor(next);
      } catch (e) {
        // No AudioContext on the track yet, or the browser refused: the share goes out unguarded.
        console.warn("[call-share] echo guard not applied", e);
        return;
      }
      if (!alive) {
        await track.stopProcessor().catch(() => {});
        return;
      }
      guard = next;
      audio = track;
      next.setDucked(remoteTalking);
    };

    const detach = async () => {
      if (hold) clearTimeout(hold);
      hold = null;
      const old = guard;
      const track = audio;
      guard = null;
      audio = null;
      if (old && track) await track.stopProcessor().catch(() => {});
    };

    const onPublished = () => void attach();
    const onUnpublished = () => {
      if (!room.localParticipant.getTrackPublication(Track.Source.ScreenShareAudio)) void detach();
    };

    room.on(RoomEvent.LocalTrackPublished, onPublished);
    room.on(RoomEvent.LocalTrackUnpublished, onUnpublished);
    room.on(RoomEvent.ActiveSpeakersChanged, onSpeakers);
    void attach();

    return () => {
      alive = false;
      room.off(RoomEvent.LocalTrackPublished, onPublished);
      room.off(RoomEvent.LocalTrackUnpublished, onUnpublished);
      room.off(RoomEvent.ActiveSpeakersChanged, onSpeakers);
      void detach();
    };
  }, [room]);
}
