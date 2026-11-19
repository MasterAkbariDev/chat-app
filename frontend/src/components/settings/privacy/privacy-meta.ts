import type { PrivacyAudience, PrivacyKey, PrivacyRuleView } from "@/lib/api/types";

export const AUDIENCE_LABEL: Record<PrivacyAudience, string> = {
  everybody: "Everybody",
  contacts: "My contacts",
  nobody: "Nobody",
};

export interface PrivacyMeta {
  /** Row label in the list and the sub-page title. */
  title: string;
  /** Radio-group heading. */
  question: string;
  /** Live explanation under the radio list, per audience. */
  explain: Record<PrivacyAudience, string>;
  /** Always-on footnote after the explanation. */
  footnote?: string;
  /** "allow"/"deny" wording for the exception sections. */
  verb: "see" | "do";
}

/** Settings order and copy (Telegram's "Privacy and security"). */
export const PRIVACY_META: Record<PrivacyKey, PrivacyMeta> = {
  phoneNumber: {
    title: "Phone number",
    question: "Who can see my phone number?",
    explain: {
      everybody: "Anyone who opens your profile can see your phone number.",
      contacts: "Only people you've saved as contacts can see your phone number.",
      nobody: "No one can see your phone number.",
    },
    verb: "see",
  },
  email: {
    title: "Email",
    question: "Who can see my email?",
    explain: {
      everybody: "Anyone who opens your profile can see your email.",
      contacts: "Only people you've saved as contacts can see your email.",
      nobody: "No one can see your email.",
    },
    verb: "see",
  },
  lastSeen: {
    title: "Last seen & online",
    question: "Who can see my last seen time?",
    explain: {
      everybody: "Everyone can see when you were last online, and when you're online now.",
      contacts: "Only people you've saved as contacts can see when you were last online.",
      nobody: "No one can see when you were last online.",
    },
    footnote:
      "It works both ways: if you don't share your last seen with someone, you won't see theirs either. People who can't see it get an approximate time instead — last seen recently, within a week, within a month or a long time ago.",
    verb: "see",
  },
  profilePhotos: {
    title: "Profile photos",
    question: "Who can see my profile photos?",
    explain: {
      everybody: "Everyone can see your profile photos and videos.",
      contacts: "Only people you've saved as contacts can see your profile photos and videos.",
      nobody: "No one else can see your profile photos and videos.",
    },
    footnote: "People who can't see them get your initials instead, and your photo gallery is empty for them.",
    verb: "see",
  },
  bio: {
    title: "Bio",
    question: "Who can see my bio?",
    explain: {
      everybody: "Everyone who opens your profile can see your bio.",
      contacts: "Only people you've saved as contacts can see your bio.",
      nobody: "No one else can see your bio.",
    },
    verb: "see",
  },
  calls: {
    title: "Calls",
    question: "Who can call me?",
    explain: {
      everybody: "Anyone you have a chat with can call you.",
      contacts: "Only people you've saved as contacts can call you.",
      nobody: "No one can call you.",
    },
    footnote: "Group calls aren't affected — anyone in the group can start one.",
    verb: "do",
  },
  groupInvites: {
    title: "Groups & channels",
    question: "Who can add me to groups and channels?",
    explain: {
      everybody: "Anyone can add you to a group or channel.",
      contacts: "Only people you've saved as contacts can add you to groups and channels.",
      nobody: "No one can add you to groups or channels.",
    },
    footnote: "People who can't add you can still send you an invite link.",
    verb: "do",
  },
  forwards: {
    title: "Forwarded messages",
    question: "Who can link to my account when forwarding my messages?",
    explain: {
      everybody: "Your forwarded messages link to your profile for everyone.",
      contacts: "Only forwards by people you've saved as contacts link to your profile.",
      nobody: "Your forwarded messages show only your name, without a link to your profile.",
    },
    verb: "do",
  },
  findByUsername: {
    title: "Find me by username",
    question: "Who can find me by my username?",
    explain: {
      everybody: "Anyone can find you by searching your exact @username.",
      contacts: "Only people you've saved as contacts can find you by searching your @username.",
      nobody: "No one new can find you by your @username.",
    },
    footnote: "People who share a chat with you can always find you by your name.",
    verb: "do",
  },
  findByPhoneOrEmail: {
    title: "Find me by phone or email",
    question: "Who can find me by my phone number or email?",
    explain: {
      everybody: "Anyone who knows your exact phone number or email can add you as a contact.",
      contacts: "Only people you've saved as contacts can find you by your phone number or email.",
      nobody: "No one can find you by your phone number or email.",
    },
    footnote: "Your phone number and email are never shown in search results.",
    verb: "do",
  },
};

/** The two sections in the list page. */
export const PRIVACY_SECTIONS: { title: string; keys: PrivacyKey[] }[] = [
  {
    title: "Privacy",
    keys: ["phoneNumber", "email", "lastSeen", "profilePhotos", "bio", "calls", "groupInvites", "forwards"],
  },
  { title: "Finding me", keys: ["findByUsername", "findByPhoneOrEmail"] },
];

/** Which exception lists apply: "Always allow" makes no sense for
 * everybody, "Never allow" none for nobody (Telegram hides them too). */
export function showsAllow(a: PrivacyAudience) {
  return a !== "everybody";
}
export function showsDeny(a: PrivacyAudience) {
  return a !== "nobody";
}

/** "My contacts (−1, +2)" — the value shown on a list row. */
export function ruleSummary(rule: Pick<PrivacyRuleView, "audience"> & { allow: unknown[]; deny: unknown[] }): string {
  const parts: string[] = [];
  if (showsDeny(rule.audience) && rule.deny.length) parts.push(`−${rule.deny.length}`);
  if (showsAllow(rule.audience) && rule.allow.length) parts.push(`+${rule.allow.length}`);
  return parts.length ? `${AUDIENCE_LABEL[rule.audience]} (${parts.join(", ")})` : AUDIENCE_LABEL[rule.audience];
}

export function isPrivacyKey(v: string): v is PrivacyKey {
  return v in PRIVACY_META;
}
