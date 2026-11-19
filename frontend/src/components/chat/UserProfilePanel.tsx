"use client";

/* eslint-disable @next/next/no-img-element -- remote, backend-hosted profile photos */
import { useEffect, useRef, useState } from "react";
import { useRouter } from "@/hooks/use-app-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AtSign,
  Bell,
  BellOff,
  Check,
  Copy,
  Eraser,
  Flag,
  ImageIcon,
  Images,
  Info,
  Mail,
  MessageCircle,
  MoreHorizontal,
  Pencil,
  Phone,
  Play,
  Trash2,
  UserMinus,
  UserPlus,
  UserRoundX,
  UserX,
  type LucideIcon,
} from "lucide-react";
import { Avatar, resolvePhotoSrc } from "@/components/ui/Avatar";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog, Dialog } from "@/components/ui/Dialog";
import { EmptyState } from "@/components/ui/EmptyState";
import { Field, Input } from "@/components/ui/Field";
import { ListGroup, ListItem } from "@/components/ui/List";
import { Menu, useMenuState, type MenuItem } from "@/components/ui/Menu";
import { PageHeader } from "@/components/ui/PageHeader";
import { Skeleton, SkeletonRow } from "@/components/ui/Skeleton";
import { Switch } from "@/components/ui/Switch";
import { ReportDialog } from "@/components/chat/ReportDialog";
import { SharedMediaBrowser } from "@/components/chat/SharedMediaBrowser";
import { NowPlayingBar } from "@/components/media/NowPlayingBar";
import { ProfileHero } from "@/components/profile/ProfileHero";
import { ProfilePhotoViewer } from "@/components/profile/ProfilePhotoViewer";
import { ProfilePhotosManager } from "@/components/profile/ProfilePhotosManager";
import { EditProfileDialog } from "@/components/settings/EditProfileDialog";
import { photoStill, useMyPhotoActions, useUserPhotos } from "@/components/profile/use-profile-photos";
import { usePresence } from "@/contexts/presence-context";
import { useCall } from "@/contexts/call-context";
import { useAuth } from "@/contexts/auth-context";
import { CHANNELS_QUERY_KEY, getChannelsMine, getOrCreateDirect, leaveChat, muteChat, unmuteChat } from "@/lib/api/chats";
import { addContact, getContacts, getUserProfile, removeContact, renameContact } from "@/lib/api/contacts";
import { clearHistory, getCommonGroups } from "@/lib/api/profile";
import { ApiError } from "@/lib/api/client";
import type { ChannelsPage } from "@/lib/api/types";
import { BLOCKED_QUERY_KEY, blockUser, getBlockedUserIds, unblockUser } from "@/lib/api/users";
import { messagesKey } from "@/lib/messages-query";
import { cn } from "@/lib/cn";
import { presenceStatus } from "@/lib/last-seen";

const CONTACTS_QUERY_KEY = ["contacts"] as const;
const GRID_MAX = 8;
const GROUPS_PREVIEW = 5;

function displayName(p: { firstName: string; lastName: string; username: string }) {
  return [p.firstName, p.lastName].filter(Boolean).join(" ") || p.username;
}

/** True when this page is the first one this tab loaded (a pasted link, a
 * new tab, a refresh) — `router.back()` would then leave the app entirely
 * (or do nothing), so the back button needs an in-app target instead. */
function landedHereDirectly(): boolean {
  if (typeof window === "undefined" || typeof performance === "undefined") return false;
  const nav = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
  return !!nav && nav.name === window.location.href;
}

const errorText = (err: unknown, fallback: string) => (err instanceof ApiError && err.status < 500 ? err.message : fallback);

type Confirming = "block" | "clear" | "delete" | "removeContact" | null;

/**
 * One Telegram-style profile for a person, used everywhere: a DM's header
 * (`/app/c/<dm>/info`, which passes `channelId`), a group's member list, a
 * sender's name or photo, contacts and search (`/app/user/<id>`). The photo
 * hero opens from a circle into a square gallery; under it, the actions
 * (Message, Call, Mute, More), the person's info, and — when you have a chat
 * with them — notifications, wallpaper, shared media and groups in common.
 * Your own profile shows Edit and Photos instead.
 */
export function UserProfilePanel({ userId, channelId }: { userId: string; channelId?: string }) {
  const { user: me } = useAuth();
  const router = useRouter();
  const queryClient = useQueryClient();
  const { startCall, connecting: callConnecting } = useCall();
  const [reportOpen, setReportOpen] = useState(false);
  const [confirming, setConfirming] = useState<Confirming>(null);
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const [editOpen, setEditOpen] = useState(false);
  const [photosOpen, setPhotosOpen] = useState(false);
  const [viewerAt, setViewerAt] = useState<number | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [mutePending, setMutePending] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const moreMenu = useMenuState();
  const isSelf = userId === me?._id;

  const profileQuery = useQuery({ queryKey: ["users", "profile", userId], queryFn: () => getUserProfile(userId) });
  // Your own profile reads your live `me`, so edits show without a refetch.
  const profile = profileQuery.data && isSelf && me ? { ...profileQuery.data, ...me } : profileQuery.data;
  const { photos } = useUserPhotos(profile);
  const { setMain } = useMyPhotoActions();
  const presence = usePresence(isSelf ? undefined : userId);
  const status = isSelf ? { text: "online", online: true } : presenceStatus(presence);

  // Your DM with them, if any — from the chat list cache (shared with the sidebar).
  const channelsQuery = useQuery({ queryKey: CHANNELS_QUERY_KEY, queryFn: () => getChannelsMine(), enabled: !isSelf });
  const dm = isSelf
    ? undefined
    : channelsQuery.data?.items.find((c) =>
        channelId ? c.channelId === channelId : c.type === "private" && c.otherUser?._id === userId,
      );
  const dmId = dm?.channelId ?? null;
  const muted = dm?.isMuted ?? false;

  const contactsQuery = useQuery({ queryKey: CONTACTS_QUERY_KEY, queryFn: getContacts, enabled: !isSelf });
  const contact = contactsQuery.data?.find((c) => c.user._id === userId) ?? null;

  const blockedQuery = useQuery({ queryKey: BLOCKED_QUERY_KEY, queryFn: getBlockedUserIds, enabled: !isSelf });
  const isBlocked = (blockedQuery.data ?? []).includes(userId);

  const groupsQuery = useQuery({ queryKey: ["chats", "common", userId], queryFn: () => getCommonGroups(userId), enabled: !isSelf });
  const [allGroups, setAllGroups] = useState(false);

  // Their "Calls" privacy (or a block) — the server says so; older servers omit it.
  const callsHidden = !isSelf && profile?.canCall === false;
  const ownName = profile ? displayName(profile) : "";
  // A contact's custom name is what you call them everywhere — Telegram shows it here too.
  const name = contact?.customName || ownName;

  function fail(err: unknown, fallback: string) {
    setActionError(errorText(err, fallback));
  }

  const blockMutation = useMutation({
    mutationFn: () => (isBlocked ? unblockUser(userId) : blockUser(userId)),
    onSuccess: () => {
      queryClient.setQueryData<string[]>(BLOCKED_QUERY_KEY, (prev) => {
        const list = prev ?? [];
        return isBlocked ? list.filter((id) => id !== userId) : [...list, userId];
      });
      setConfirming(null);
    },
    onError: (err) => fail(err, "That didn't go through. Check your connection and try again."),
  });

  async function ensureDm(): Promise<string> {
    if (dmId) return dmId;
    const chat = await getOrCreateDirect(userId);
    await queryClient.invalidateQueries({ queryKey: CHANNELS_QUERY_KEY });
    return chat._id;
  }

  const messageMutation = useMutation({
    mutationFn: ensureDm,
    onSuccess: (id) => router.push(`/app/c/${id}`),
    onError: (err) => fail(err, "Couldn't open the chat. Check your connection and try again."),
  });

  const callMutation = useMutation({
    mutationFn: ensureDm,
    onSuccess: (id) => startCall(id, name, true),
    onError: (err) => fail(err, "Couldn't start the call. Check your connection and try again."),
  });

  function toggleMute() {
    if (!dmId) return;
    setMutePending(true);
    setActionError(null);
    // Optimistic: flip the cached row so the tile and switch answer at once.
    const flip = (value: boolean) =>
      queryClient.setQueryData<ChannelsPage>(CHANNELS_QUERY_KEY, (page) =>
        page ? { ...page, items: page.items.map((c) => (c.channelId === dmId ? { ...c, isMuted: value } : c)) } : page,
      );
    const next = !muted;
    flip(next);
    (next ? muteChat(dmId) : unmuteChat(dmId))
      .then(() => queryClient.invalidateQueries({ queryKey: CHANNELS_QUERY_KEY }))
      .catch((err) => {
        flip(!next);
        fail(err, "Couldn't change notifications. Check your connection and try again.");
      })
      .finally(() => setMutePending(false));
  }

  const invalidateContacts = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: CONTACTS_QUERY_KEY }),
      // Phone/email visibility depends on contact status.
      queryClient.invalidateQueries({ queryKey: ["users", "profile", userId] }),
    ]);

  const addContactMutation = useMutation({
    mutationFn: () => addContact({ userId }),
    onSuccess: invalidateContacts,
    onError: (err) => fail(err, "Couldn't add them. Check your connection and try again."),
  });
  const removeContactMutation = useMutation({
    mutationFn: () => removeContact(contact!._id),
    onSuccess: async () => {
      await invalidateContacts();
      setConfirming(null);
    },
  });
  const renameMutation = useMutation({
    mutationFn: (customName: string | null) => renameContact(contact!._id, customName),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: CONTACTS_QUERY_KEY });
      setRenameOpen(false);
    },
  });

  const clearMutation = useMutation({
    mutationFn: () => clearHistory(dmId!),
    onSuccess: async () => {
      setConfirming(null);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: messagesKey(dmId!) }),
        queryClient.invalidateQueries({ queryKey: ["messages", "shared", dmId!] }),
        queryClient.invalidateQueries({ queryKey: ["messages", "pinned", dmId!] }),
        // The chat list's preview/time/unread for this chat.
        queryClient.invalidateQueries({ queryKey: CHANNELS_QUERY_KEY }),
      ]);
    },
  });
  const deleteMutation = useMutation({
    mutationFn: () => leaveChat(dmId!),
    onSuccess: () => {
      setConfirming(null);
      router.push("/app");
      queryClient.invalidateQueries({ queryKey: CHANNELS_QUERY_KEY });
    },
  });

  function goBack() {
    if (landedHereDirectly()) router.push("/app");
    else router.back();
  }

  const moreItems: MenuItem[] = isSelf
    ? []
    : [
        ...(contact
          ? [
              {
                key: "edit-contact",
                label: "Edit contact",
                icon: Pencil,
                onSelect: () => {
                  renameMutation.reset();
                  setRenameValue(contact.customName ?? "");
                  setRenameOpen(true);
                },
              },
              {
                key: "remove-contact",
                label: "Delete contact",
                icon: UserMinus,
                onSelect: () => {
                  removeContactMutation.reset();
                  setConfirming("removeContact");
                },
              },
            ]
          : [{ key: "add-contact", label: "Add to contacts", icon: UserPlus, disabled: contactsQuery.isPending, onSelect: () => addContactMutation.mutate() }]),
        { key: "sep1", separator: true as const },
        {
          key: "block",
          label: isBlocked ? "Unblock" : "Block",
          icon: UserX,
          danger: !isBlocked,
          // Until the blocked list loads we don't know which way this toggles.
          disabled: blockedQuery.isPending || blockMutation.isPending,
          onSelect: () => {
            setActionError(null);
            if (isBlocked) blockMutation.mutate();
            else setConfirming("block");
          },
        },
        { key: "report", label: "Report", icon: Flag, danger: true, onSelect: () => setReportOpen(true) },
        ...(dmId
          ? [
              { key: "sep2", separator: true as const },
              {
                key: "clear",
                label: "Clear history",
                icon: Eraser,
                onSelect: () => {
                  clearMutation.reset();
                  setConfirming("clear");
                },
              },
              {
                key: "delete",
                label: "Delete chat",
                icon: Trash2,
                danger: true,
                onSelect: () => {
                  deleteMutation.reset();
                  setConfirming("delete");
                },
              },
            ]
          : []),
      ];

  const groups = groupsQuery.data ?? [];

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-canvas">
      <PageHeader
        title={isSelf ? "Your profile" : "Profile"}
        {...(channelId ? { backHref: `/app/c/${channelId}`, backLabel: "Back to conversation" } : { onBack: goBack })}
        backOnDesktop
      />
      {/* Chat routes don't get the app shell's strip — show it here so voice played below has controls. */}
      {channelId ? <NowPlayingBar /> : null}

      <div ref={scrollRef} className="@container min-h-0 flex-1 overflow-y-auto overscroll-y-contain">
        <div className={cn("mx-auto w-full max-w-[480px]", !isSelf && dmId ? "" : "pb-24 lg:pb-10")}>
          {profileQuery.isPending ? (
            <div aria-hidden className="flex flex-col items-center gap-3 px-4 pt-6">
              <Skeleton className="size-[120px] rounded-full" />
              <Skeleton className="mt-2 h-7 w-48" />
              <Skeleton className="h-4 w-32" />
              <Skeleton className="mt-5 h-[68px] w-full rounded-[var(--radius-md)]" />
              <Skeleton className="mt-3 h-36 w-full rounded-[var(--radius-md)]" />
            </div>
          ) : profileQuery.isError || !profile ? (
            <div className="px-4 pt-5">
              <EmptyState
                icon={UserRoundX}
                title="Couldn't load this profile"
                description="They may not exist, or have blocked you."
                action={channelId ? { label: "Back to conversation", onClick: () => router.push(`/app/c/${channelId}`) } : { label: "Go back", onClick: goBack }}
              />
            </div>
          ) : (
            <ProfileHero
              colorId={profile._id}
              name={name}
              username={profile.username}
              status={status}
              photos={photos}
              onSetMain={isSelf ? (p) => setMain.mutateAsync(p.id) : undefined}
              scrollRef={scrollRef}
            >
              <div className="flex flex-col gap-6 px-4 pt-6">
                {isSelf ? (
                  <div className="grid grid-cols-2 gap-2">
                    <Button variant="secondary" size="lg" onClick={() => setEditOpen(true)}>
                      <Pencil className="size-[18px]" strokeWidth={1.9} aria-hidden />
                      Edit profile
                    </Button>
                    <Button variant="secondary" size="lg" onClick={() => setPhotosOpen(true)}>
                      <Images className="size-[18px]" strokeWidth={1.9} aria-hidden />
                      Photos
                    </Button>
                  </div>
                ) : (
                  <div className="flex flex-col gap-2">
                    <div className="grid auto-cols-fr grid-flow-col gap-2">
                      <ActionTile
                        icon={MessageCircle}
                        label="Message"
                        busy={messageMutation.isPending}
                        onClick={() => {
                          setActionError(null);
                          messageMutation.mutate();
                        }}
                      />
                      <ActionTile
                        icon={Phone}
                        label="Call"
                        busy={callMutation.isPending || callConnecting}
                        disabled={isBlocked || callsHidden}
                        title={callsHidden ? `${name} doesn't accept calls from you` : undefined}
                        onClick={() => {
                          setActionError(null);
                          callMutation.mutate();
                        }}
                      />
                      {dmId ? (
                        <ActionTile icon={muted ? BellOff : Bell} label={muted ? "Unmute" : "Mute"} active={muted} disabled={mutePending} onClick={toggleMute} />
                      ) : null}
                      <ActionTile
                        icon={MoreHorizontal}
                        label="More"
                        aria-haspopup="menu"
                        aria-expanded={moreMenu.open}
                        onClick={(e) => moreMenu.openFrom(e.currentTarget)}
                      />
                    </div>
                    {actionError ? (
                      <p role="alert" className="text-center text-[13.5px] text-danger">
                        {actionError}
                      </p>
                    ) : null}
                    {callsHidden && !isBlocked ? (
                      <p className="text-center text-[13.5px] text-muted">{name} doesn&apos;t accept calls from you.</p>
                    ) : null}
                    {isBlocked ? (
                      <p className="text-center text-[13.5px] text-muted">
                        You blocked {name}.{" "}
                        <button
                          type="button"
                          className="font-semibold text-accent-text hover:underline"
                          disabled={blockMutation.isPending}
                          onClick={() => blockMutation.mutate()}
                        >
                          {blockMutation.isPending ? "Unblocking…" : "Unblock"}
                        </button>
                      </p>
                    ) : null}
                  </div>
                )}

                <ListGroup
                  title="Info"
                  description={
                    !isSelf && !profile.phoneNumber && !profile.email
                      ? `${name}'s privacy settings decide whether their phone number and email show here.`
                      : undefined
                  }
                >
                  {profile.bio ? (
                    <div className="flex items-start gap-3 px-4 py-3">
                      <span className="flex size-9 shrink-0 items-center justify-center rounded-[var(--radius-sm)] bg-sunken text-fg-2">
                        <Info className="size-[18px]" strokeWidth={1.8} aria-hidden />
                      </span>
                      <span className="min-w-0 flex-1 pt-0.5">
                        <span dir="auto" className="block whitespace-pre-wrap break-words text-[15px] leading-relaxed text-fg">
                          {profile.bio}
                        </span>
                        <span className="mt-0.5 block text-[13px] text-muted">Bio</span>
                      </span>
                    </div>
                  ) : null}
                  <ListItem
                    icon={AtSign}
                    title={`@${profile.username}`}
                    subtitle="Username"
                    trailing={<CopyButton text={`@${profile.username}`} label="Copy username" />}
                  />
                  {profile.phoneNumber ? (
                    <ListItem
                      icon={Phone}
                      title={
                        <a href={`tel:${profile.phoneNumber}`} dir="ltr" className="tabular hover:underline">
                          {profile.phoneNumber}
                        </a>
                      }
                      subtitle="Phone"
                      trailing={<CopyButton text={profile.phoneNumber} label="Copy phone number" />}
                    />
                  ) : null}
                  {profile.email ? (
                    <ListItem
                      icon={Mail}
                      title={
                        <a href={`mailto:${profile.email}`} className="hover:underline">
                          {profile.email}
                        </a>
                      }
                      subtitle="Email"
                      trailing={<CopyButton text={profile.email} label="Copy email" />}
                    />
                  ) : null}
                  {!isSelf && contact?.customName && contact.customName !== ownName ? (
                    <ListItem icon={Pencil} title={ownName} subtitle="Their own name" />
                  ) : null}
                </ListGroup>

                {!isSelf && dmId ? (
                  <ListGroup>
                    <div className="flex min-h-[60px] items-center gap-3 px-4 py-2.5">
                      <span className="flex size-9 shrink-0 items-center justify-center rounded-[var(--radius-sm)] bg-sunken text-fg-2">
                        {muted ? <BellOff className="size-[18px]" strokeWidth={1.8} aria-hidden /> : <Bell className="size-[18px]" strokeWidth={1.8} aria-hidden />}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span id="dm-notifications" className="block text-[15px] font-medium text-fg">
                          Notifications
                        </span>
                        <span className="mt-0.5 block text-[13px] text-muted">{muted ? "Muted" : "On"}</span>
                      </span>
                      <Switch checked={!muted} onChange={toggleMute} disabled={mutePending} aria-labelledby="dm-notifications" />
                    </div>
                    <ListItem icon={ImageIcon} title="Wallpaper" subtitle="Just for this chat" href={`/app/settings/wallpaper?chat=${dmId}`} />
                  </ListGroup>
                ) : null}

                {photos.length > 1 ? (
                  <section className="flex flex-col gap-2" aria-labelledby="profile-photos-title">
                    <h2 id="profile-photos-title" className="flex items-baseline justify-between px-1 text-[13.5px] font-semibold text-muted">
                      Photos
                      <span className="tabular font-medium">{photos.length}</span>
                    </h2>
                    <ul className="grid grid-cols-4 gap-1 overflow-hidden rounded-[var(--radius-md)] border border-line bg-panel p-1">
                      {photos.slice(0, GRID_MAX).map((p, i) => {
                        const src = resolvePhotoSrc(photoStill(p));
                        const more = i === GRID_MAX - 1 && photos.length > GRID_MAX ? photos.length - GRID_MAX : 0;
                        return (
                          <li key={p.id}>
                            <button
                              type="button"
                              onClick={() => setViewerAt(i)}
                              aria-label={`Open photo ${i + 1} of ${photos.length}${p.isMain ? ", main photo" : ""}${p.kind === "video" ? ", video" : ""}`}
                              className="pressable relative block aspect-square w-full overflow-hidden rounded-[9px] bg-sunken"
                            >
                              {src ? <img src={src} alt="" loading="lazy" decoding="async" draggable={false} className="size-full object-cover" /> : null}
                              {p.kind === "video" ? (
                                <span aria-hidden className="absolute bottom-1 start-1 flex size-5 items-center justify-center rounded-full bg-black/55 text-white">
                                  <Play className="size-2.5 fill-current" strokeWidth={0} />
                                </span>
                              ) : null}
                              {more ? (
                                <span aria-hidden className="absolute inset-0 flex items-center justify-center bg-black/50 text-[17px] font-bold text-white">
                                  +{more}
                                </span>
                              ) : null}
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  </section>
                ) : null}

                {/* With a chat, groups in common are a tab of the shared media below. */}
                {!isSelf && !dmId && (groupsQuery.isPending || groups.length > 0) ? (
                  <ListGroup title={groupsQuery.isPending ? "Groups in common" : `${groups.length} ${groups.length === 1 ? "group" : "groups"} in common`}>
                    {groupsQuery.isPending ? (
                      <SkeletonRow />
                    ) : (
                      <>
                        {(allGroups ? groups : groups.slice(0, GROUPS_PREVIEW)).map((g) => (
                          <ListItem
                            key={g._id}
                            leading={<Avatar colorId={g._id} name={g.name} src={g.image?.[0]} size={40} shape="square" />}
                            title={<span dir="auto">{g.name}</span>}
                            subtitle={`${g.memberCount} ${g.memberCount === 1 ? "member" : "members"}`}
                            href={`/app/c/${g._id}`}
                          />
                        ))}
                        {!allGroups && groups.length > GROUPS_PREVIEW ? (
                          <button
                            type="button"
                            onClick={() => setAllGroups(true)}
                            className="focus-inset flex min-h-12 w-full items-center px-4 text-[15px] font-semibold text-accent-text hover:bg-sunken"
                          >
                            Show all {groups.length}
                          </button>
                        ) : null}
                      </>
                    )}
                  </ListGroup>
                ) : null}
              </div>
              {/* Shared media takes the rest of the page, full width, tabs stuck under the header. */}
              {!isSelf && dmId ? <SharedMediaBrowser channelId={dmId} commonWithUserId={userId} className="mt-6" /> : null}
            </ProfileHero>
          )}
        </div>
      </div>

      {moreMenu.anchor && moreItems.length ? (
        <Menu anchor={moreMenu.anchor} aria-label={`More options for ${name}`} onClose={moreMenu.close} items={moreItems} />
      ) : null}

      {confirming === "block" && profile ? (
        <ConfirmDialog
          title={`Block ${name}?`}
          description="They won't be able to call you or find you in search. A message they send to a shared chat still reaches you eventually — just not live."
          confirmLabel={`Block ${name}`}
          destructive
          pending={blockMutation.isPending}
          onConfirm={() => blockMutation.mutate()}
          onClose={() => setConfirming(null)}
        />
      ) : null}

      {confirming === "removeContact" && contact ? (
        <ConfirmDialog
          title={`Delete ${name} from contacts?`}
          description={
            <>
              Your chat with them stays, and you can add them again anytime.
              {removeContactMutation.isError ? (
                <span role="alert" className="mt-2 block text-danger">
                  Couldn&apos;t remove them. Check your connection and try again.
                </span>
              ) : null}
            </>
          }
          confirmLabel="Delete contact"
          destructive
          pending={removeContactMutation.isPending}
          onConfirm={() => removeContactMutation.mutate()}
          onClose={() => setConfirming(null)}
        />
      ) : null}

      {confirming === "clear" && dmId ? (
        <ConfirmDialog
          title="Clear history?"
          description={
            <>
              Removes every message in this chat for you. {name} still sees them. This can&apos;t be undone.
              {clearMutation.isError ? (
                <span role="alert" className="mt-2 block text-danger">
                  {errorText(clearMutation.error, "Couldn't clear it. Check your connection and try again.")}
                </span>
              ) : null}
            </>
          }
          confirmLabel="Clear history"
          destructive
          pending={clearMutation.isPending}
          onConfirm={() => clearMutation.mutate()}
          onClose={() => setConfirming(null)}
        />
      ) : null}

      {confirming === "delete" && dmId ? (
        <ConfirmDialog
          title="Delete this chat?"
          description={
            <>
              It leaves your chat list and its history is cleared for you. {name} keeps their copy. Messaging them again starts a fresh chat.
              {deleteMutation.isError ? (
                <span role="alert" className="mt-2 block text-danger">
                  {errorText(deleteMutation.error, "Couldn't delete it. Check your connection and try again.")}
                </span>
              ) : null}
            </>
          }
          confirmLabel="Delete chat"
          destructive
          pending={deleteMutation.isPending}
          onConfirm={() => deleteMutation.mutate()}
          onClose={() => setConfirming(null)}
        />
      ) : null}

      {renameOpen && contact ? (
        <Dialog
          onClose={() => setRenameOpen(false)}
          title="Edit contact"
          description="Only you see this name. Leave it empty to use their own name."
          onSubmit={() => renameMutation.mutate(renameValue.trim() || null)}
          bodyClassName="pb-4"
          footer={
            <>
              <Button variant="secondary" onClick={() => setRenameOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" loading={renameMutation.isPending}>
                Save
              </Button>
            </>
          }
        >
          <Field
            label="Name"
            error={renameMutation.isError ? errorText(renameMutation.error, "Couldn't save the name. Check your connection and try again.") : undefined}
          >
            <Input value={renameValue} onChange={(e) => setRenameValue(e.target.value)} placeholder={ownName} autoComplete="off" dir="auto" data-autofocus />
          </Field>
        </Dialog>
      ) : null}

      {viewerAt !== null && profile ? (
        <ProfilePhotoViewer
          photos={photos}
          startIndex={viewerAt}
          name={name}
          onSetMain={isSelf ? (p) => setMain.mutateAsync(p.id) : undefined}
          onClose={() => setViewerAt(null)}
        />
      ) : null}
      {editOpen ? <EditProfileDialog onClose={() => setEditOpen(false)} /> : null}
      {photosOpen ? <ProfilePhotosManager onClose={() => setPhotosOpen(false)} /> : null}

      {reportOpen && profile ? (
        <ReportDialog targetType="user" targetId={userId} targetLabel={`@${profile.username}`} onClose={() => setReportOpen(false)} />
      ) : null}
    </div>
  );
}

const tileClasses =
  "pressable flex min-h-[68px] min-w-0 flex-col items-center justify-center gap-1.5 rounded-[var(--radius-md)] border border-line bg-panel px-1.5 py-2.5 text-[13px] font-semibold text-accent-text transition-colors duration-[var(--dur-fast)] hover:border-line-strong hover:bg-sunken disabled:opacity-50";

function ActionTile({
  icon: Icon,
  label,
  onClick,
  active,
  disabled,
  busy,
  title,
  ...aria
}: {
  icon: LucideIcon;
  label: string;
  onClick: (e: React.MouseEvent<HTMLButtonElement>) => void;
  /** Visual "on" state (muted). The label names the action, so no aria-pressed. */
  active?: boolean;
  disabled?: boolean;
  busy?: boolean;
  /** Tooltip — says why a tile is disabled. */
  title?: string;
  "aria-haspopup"?: "menu";
  "aria-expanded"?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      title={title}
      className={cn(tileClasses, active && "border-transparent bg-accent-soft hover:border-transparent hover:bg-accent-soft")}
      {...aria}
    >
      <Icon className={cn("size-[22px]", busy && "animate-pulse")} strokeWidth={1.9} aria-hidden />
      <span className="max-w-full truncate">{label}</span>
    </button>
  );
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          if (timer.current) clearTimeout(timer.current);
          timer.current = setTimeout(() => setCopied(false), 2000);
        } catch {
          // No clipboard access (insecure context) — the text is selectable.
        }
      }}
      aria-label={copied ? "Copied" : label}
      title={copied ? "Copied" : label}
      className="pressable -me-2 flex size-10 items-center justify-center rounded-full text-muted hover:bg-sunken hover:text-fg"
    >
      {copied ? <Check className="size-[18px] text-success" strokeWidth={2.2} aria-hidden /> : <Copy className="size-[17px]" strokeWidth={1.9} aria-hidden />}
      <span role="status" className="sr-only">
        {copied ? "Copied" : ""}
      </span>
    </button>
  );
}

