import type { ChatKind } from "@/lib/api/types";

/** "1 member" / "12 subscribers" — channels have subscribers, groups have members. */
export function memberCountLabel(type: ChatKind | undefined, count: number): string {
  const noun = type === "channel" ? "subscriber" : "member";
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** "group" / "channel" (lower case, for use mid-sentence). */
export function chatKindNoun(type: ChatKind | undefined): string {
  return type === "channel" ? "channel" : type === "group" ? "group" : "chat";
}

/** "Public group", "Private channel"… */
export function visibilityLabel(type: ChatKind | undefined, isPublic: boolean | undefined): string {
  return `${isPublic ? "Public" : "Private"} ${chatKindNoun(type)}`;
}
