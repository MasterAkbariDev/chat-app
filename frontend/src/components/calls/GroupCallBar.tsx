"use client";

import { useQuery } from "@tanstack/react-query";
import { AudioLines } from "lucide-react";
import { Avatar } from "@/components/ui/Avatar";
import { Button } from "@/components/ui/Button";
import { useCall } from "@/contexts/call-context";
import { getGroupCall, groupCallKey, type GroupCallParticipant } from "@/lib/api/calls";
import { CHANNELS_QUERY_KEY, getChannelsMine } from "@/lib/api/chats";
import type { ChannelsPage } from "@/lib/api/types";

/** How many avatars the bar stacks before "+n". */
const MAX_FACES = 3;

export function participantsLabel(count: number): string {
  return count === 1 ? "1 participant" : `${count} participants`;
}

/**
 * Telegram's voice chat bar, under a group/channel's header while a voice
 * chat runs there: "Voice chat · 3 participants", the first few faces, and
 * Join (or "You're in" while this device is in it). The roster comes from
 * GET /calls/channel/:id on open and then the `group_call_updated` socket
 * event (call-context writes it into this same query).
 */
export function GroupCallBar({ channelId, title }: { channelId: string; title: string }) {
  const { activeCall, connecting, startCall, endCall } = useCall();
  const query = useQuery({
    queryKey: groupCallKey(channelId),
    queryFn: () => getGroupCall(channelId),
    staleTime: 15_000,
  });
  const call = query.data;
  if (!call) return null;

  const inThisCall = activeCall?.callId === call.callId;
  const inOtherCall = !!activeCall && !inThisCall;
  const count = call.participants.length;
  const faces = call.participants.slice(0, MAX_FACES);

  return (
    <div
      role="region"
      aria-label="Voice chat"
      className="flex min-h-[52px] shrink-0 items-center gap-3 border-b border-line bg-panel py-1.5 pe-2 ps-4 lg:pe-4 lg:ps-6"
    >
      <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-success-soft text-success" aria-hidden>
        <AudioLines className="size-[18px]" strokeWidth={2} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-[13px] font-bold text-success">Voice chat</span>
        <span className="block truncate text-[14px] text-fg-2">
          {count > 0 ? participantsLabel(count) : "Starting…"}
          {inThisCall ? " · You're in" : null}
        </span>
      </span>
      {faces.length ? <Faces people={faces} extra={count - faces.length} /> : null}
      {inThisCall ? (
        <Button variant="secondary" size="sm" onClick={endCall}>
          Leave
        </Button>
      ) : (
        <Button
          size="sm"
          onClick={() => startCall(channelId, title, false)}
          disabled={inOtherCall || connecting}
          loading={connecting}
          aria-label={`Join voice chat${count ? `, ${participantsLabel(count)}` : ""}`}
          title={inOtherCall ? "You're already in a call" : undefined}
          className="bg-success text-canvas hover:bg-success hover:brightness-110"
        >
          Join
        </Button>
      )}
    </div>
  );
}

function Faces({ people, extra }: { people: GroupCallParticipant[]; extra: number }) {
  return (
    <span className="flex shrink-0 items-center" aria-hidden>
      {people.map((p, i) => (
        <span key={p._id} className="rounded-full ring-2 ring-panel" style={{ marginInlineStart: i ? -8 : 0, zIndex: people.length - i }}>
          <Avatar colorId={p._id} name={p.name} src={p.photo} size={28} />
        </span>
      ))}
      {extra > 0 ? <span className="tabular ms-1.5 text-[12.5px] font-semibold text-muted">+{extra}</span> : null}
    </span>
  );
}

/** Whether a chat has a live voice chat, from the chat-list cache (never
 *  fetches; `group_call_updated` keeps the summary's `activeCall` current). */
export function useChatHasVoiceChat(channelId: string): boolean {
  const { data } = useQuery({
    queryKey: CHANNELS_QUERY_KEY,
    queryFn: () => getChannelsMine(),
    enabled: false,
    select: (page: ChannelsPage) => !!page.items.find((c) => c.channelId === channelId)?.activeCall,
  });
  return !!data;
}

/** The chat-list row's "voice chat live" mark, on the avatar's corner. */
export function VoiceChatBadge() {
  return (
    <span
      className="absolute -bottom-0.5 -end-0.5 flex size-[20px] items-center justify-center rounded-full bg-success text-canvas ring-2 ring-panel"
      aria-hidden
    >
      <AudioLines className="size-3" strokeWidth={2.4} />
    </span>
  );
}
