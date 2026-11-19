"use client";

import { createContext, useContext, useEffect, useReducer, useState, useSyncExternalStore } from "react";
import { useParticipantInfo } from "@livekit/components-react";
import {
  MediaDeviceFailure,
  ParticipantEvent,
  Track,
  TrackEvent,
  type LocalVideoTrack,
  type Participant,
  type TrackPublication,
} from "livekit-client";
import { useAuth } from "@/contexts/auth-context";
import type { ActiveCall } from "@/contexts/call-context";
import { parseParticipantMeta } from "./call-utils";

/** The active call, for components deep in the stage that need its
 * title/peer info without threading props through every layout. */
export const ActiveCallContext = createContext<ActiveCall | null>(null);

const TRACK_EVENTS = [
  ParticipantEvent.TrackMuted,
  ParticipantEvent.TrackUnmuted,
  ParticipantEvent.TrackPublished,
  ParticipantEvent.TrackUnpublished,
  ParticipantEvent.TrackSubscribed,
  ParticipantEvent.TrackUnsubscribed,
  ParticipantEvent.TrackStreamStateChanged,
  ParticipantEvent.LocalTrackPublished,
  ParticipantEvent.LocalTrackUnpublished,
] as const;

/** Whether `participant`'s `source` video should be on screen right now —
 * published, subscribed (remote), not muted, and its MediaStreamTrack still
 * live. Re-evaluated on every track event, so turning a camera off (which
 * LiveKit does by *muting*, not unpublishing) or a camera that dies
 * mid-call flips the tile back to the avatar instead of a frozen/black box. */
export function useVideoPublication(participant: Participant, source: Track.Source) {
  const [, bump] = useReducer((n: number) => n + 1, 0);

  useEffect(() => {
    const on = () => bump();
    for (const ev of TRACK_EVENTS) participant.on(ev, on);
    return () => {
      for (const ev of TRACK_EVENTS) participant.off(ev, on);
    };
  }, [participant]);

  const publication: TrackPublication | undefined = participant.getTrackPublication(source);
  const track = publication?.track;

  useEffect(() => {
    if (!track) return;
    const on = () => bump();
    const mst = track.mediaStreamTrack;
    track.on(TrackEvent.Ended, on);
    track.on(TrackEvent.Restarted, on);
    track.on(TrackEvent.Muted, on);
    track.on(TrackEvent.Unmuted, on);
    mst?.addEventListener("ended", on);
    return () => {
      track.off(TrackEvent.Ended, on);
      track.off(TrackEvent.Restarted, on);
      track.off(TrackEvent.Muted, on);
      track.off(TrackEvent.Unmuted, on);
      mst?.removeEventListener("ended", on);
    };
  }, [track]);

  const on = !!publication && !!track && !publication.isMuted && track.mediaStreamTrack?.readyState !== "ended";
  // Front cameras are mirrored (what every call app does for the self-view);
  // a rear camera isn't. Desktop webcams report no facingMode → mirrored.
  const facing = participant.isLocal && on ? (track as LocalVideoTrack).mediaStreamTrack?.getSettings?.().facingMode : undefined;
  const mirror = participant.isLocal && source === Track.Source.Camera && facing !== "environment";
  return { publication, on, mirror };
}

/** Display name + photo for a participant: the token's `name`/metadata,
 * then whatever the chat list knew about a private call's peer, then the
 * signed-in user's own profile for the local participant. */
export function useParticipantDisplay(participant: Participant) {
  const call = useContext(ActiveCallContext);
  const { user } = useAuth();
  const info = useParticipantInfo({ participant });
  const metaPhoto = parseParticipantMeta(info.metadata).photo;
  const isLocal = participant.isLocal;
  const ownName = user ? [user.firstName, user.lastName].filter(Boolean).join(" ") || user.username : "";
  const name = info.name || (isLocal ? ownName : "") || (call?.peerId === participant.identity ? call?.title : "") || "Someone";
  const photo =
    metaPhoto ??
    (isLocal ? (user?.avatarUrl?.[0] ?? null) : call?.peerId && call.peerId === participant.identity ? call.photo : null);
  return { name, photo, isLocal, colorId: participant.identity || (isLocal ? user?._id : undefined) };
}

/** Live size of an element (ResizeObserver), for sizing avatars to tiles. */
export function useElementSize<T extends HTMLElement>() {
  const [node, setNode] = useState<T | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    if (!node) return;
    const ro = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      setSize((prev) => (prev.width === width && prev.height === height ? prev : { width, height }));
    });
    ro.observe(node);
    return () => ro.disconnect();
  }, [node]);
  return [setNode, size] as const;
}

function subscribeMedia(query: string) {
  return (cb: () => void) => {
    const mq = window.matchMedia(query);
    mq.addEventListener("change", cb);
    return () => mq.removeEventListener("change", cb);
  };
}

export function useMediaQuery(query: string) {
  return useSyncExternalStore(
    subscribeMedia(query),
    () => window.matchMedia(query).matches,
    () => false,
  );
}

/** Touch-first device (phone/tablet): flip uses front/back `facingMode`,
 * and speaker/earpiece routing is up to the OS. */
export function useIsTouchDevice() {
  return useMediaQuery("(pointer: coarse)");
}

export type DeviceKind = "mic" | "camera";
export interface DeviceIssue {
  kind: DeviceKind;
  failure: MediaDeviceFailure | "Other";
}

export function describeDeviceIssue({ kind, failure }: DeviceIssue): string {
  const noun = kind === "mic" ? "microphone" : "camera";
  switch (failure) {
    case MediaDeviceFailure.PermissionDenied:
      return `${kind === "mic" ? "Microphone" : "Camera"} access is blocked. Allow it in your browser's site settings, then try again.`;
    case MediaDeviceFailure.NotFound:
      return `No ${noun} found. Connect one, then try again.`;
    case MediaDeviceFailure.DeviceInUse:
      return `Your ${noun} is being used by another app.`;
    default:
      return `Couldn't start your ${noun}.`;
  }
}

export function toDeviceIssue(kind: DeviceKind, error: unknown): DeviceIssue {
  return { kind, failure: MediaDeviceFailure.getFailure(error) ?? "Other" };
}
