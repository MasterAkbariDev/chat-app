"use client";

import { useId, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Bell, BellRing, Bot, Camera, ChevronRight, KeyRound, ListFilter, Lock, LogOut, Monitor, Palette, Pencil, ShieldOff, Smartphone, SmilePlus, Sticker, UserRound, UserX } from "lucide-react";
import Link from "next/link";
import { Avatar } from "@/components/ui/Avatar";
import { Button, buttonClasses } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/Dialog";
import { ListGroup, ListItem } from "@/components/ui/List";
import { ToastSettings } from "@/components/settings/ToastSettings";
import { InstallAppSettings } from "@/components/settings/InstallAppSettings";
import { PageBody, PageHeader } from "@/components/ui/PageHeader";
import { Skeleton } from "@/components/ui/Skeleton";
import { Spinner } from "@/components/ui/Spinner";
import { Switch } from "@/components/ui/Switch";
import { ChangePasswordDialog } from "@/components/settings/ChangePasswordDialog";
import { EditProfileDialog } from "@/components/settings/EditProfileDialog";
import { ProfilePhotosManager } from "@/components/profile/ProfilePhotosManager";
import { NotificationSettingsDialog } from "@/components/settings/NotificationSettingsDialog";
import { QuickReactionDialog, QuickReactionGlyph } from "@/components/settings/QuickReactionDialog";
import { useAuth } from "@/contexts/auth-context";
import { getSessions, logoutAllSessions, revokeSession } from "@/lib/api/auth";
import { setAccessToken } from "@/lib/api/token-store";
import type { NotificationLevel, Session } from "@/lib/api/types";
import { formatDeviceLabel } from "@/lib/format-device";
import {
  disablePushNotifications,
  enablePushNotifications,
  getStoredPushState,
  isPushConfigured,
  isPushLikelySupported,
} from "@/lib/push";

const NOTIFICATION_LEVEL_LABEL: Record<NotificationLevel, string> = {
  all: "All messages",
  mentions: "Mentions only",
  none: "None",
};

function formatRelative(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const minutes = Math.round(diffMs / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function isMobileDevice(userAgent: string | undefined): boolean {
  return !!userAgent && /iPhone|iPod|iPad|Android/.test(userAgent);
}

/** Sessions carry no "is this me" flag (GET /v1/auth/sessions returns bare
 * rows, and the refresh token is opaque), so "This device" is a best guess:
 * the most recently used session whose stored User-Agent is exactly this
 * browser's. Purely a display hint — nothing is gated on it. */
function guessCurrentSessionId(sessions: Session[]): string | null {
  if (typeof navigator === "undefined") return null;
  const ua = navigator.userAgent;
  const mine = sessions.filter((s) => s.device === ua).sort((a, b) => b.lastUsedAt.localeCompare(a.lastUsedAt));
  return mine[0]?._id ?? null;
}

function pushStatusText(pushEnabled: boolean): string {
  if (!isPushLikelySupported()) return "Not supported in this browser";
  if (getStoredPushState().permission === "denied")
    return "Blocked by your browser — allow notifications for this site in your browser's settings first";
  return pushEnabled ? "On for this browser" : "Get notified even when this tab isn't open";
}

export default function SettingsPage() {
  const { user, logout } = useAuth();
  const queryClient = useQueryClient();
  const [loggingOutAll, setLoggingOutAll] = useState(false);
  const [changePasswordOpen, setChangePasswordOpen] = useState(false);
  const [editProfileOpen, setEditProfileOpen] = useState(false);
  const [photosOpen, setPhotosOpen] = useState(false);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [quickReactionOpen, setQuickReactionOpen] = useState(false);
  const [confirmLogoutOpen, setConfirmLogoutOpen] = useState(false);
  const [confirmLogoutAllOpen, setConfirmLogoutAllOpen] = useState(false);
  const [revokeTarget, setRevokeTarget] = useState<Session | null>(null);
  const [revoking, setRevoking] = useState(false);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [pushEnabled, setPushEnabled] = useState(() => getStoredPushState().enabled);
  const [pushPending, setPushPending] = useState(false);
  const [pushError, setPushError] = useState<string | null>(null);
  const pushLabelId = useId();

  async function togglePush() {
    setPushPending(true);
    setPushError(null);
    try {
      if (pushEnabled) {
        await disablePushNotifications();
        setPushEnabled(false);
      } else {
        const token = await enablePushNotifications();
        setPushEnabled(!!token);
        if (!token) {
          // Every "can't enable" path inside enablePushNotifications() returns
          // null quietly (permission denied, unsupported, a falsy token from
          // FCM) rather than throwing — the denied case already gets its own
          // message below via a live Notification.permission read, so this
          // only fires for the remaining, less common cases.
          setPushError(
            getStoredPushState().permission === "denied"
              ? null
              : "Couldn't turn on notifications — try again, or check your browser's site settings.",
          );
        }
      }
    } catch {
      // A genuine thrown failure (service worker registration, network error
      // registering the token with the backend, etc.) — previously unhandled
      // here entirely, so the toggle just silently snapped back to "off"
      // with no indication anything went wrong.
      setPushError("Couldn't turn on notifications. Check your connection and try again.");
      setPushEnabled(false);
    } finally {
      setPushPending(false);
    }
  }

  const sessionsQuery = useQuery({ queryKey: ["auth", "sessions"], queryFn: getSessions });

  const currentSessionId = useMemo(() => (sessionsQuery.data ? guessCurrentSessionId(sessionsQuery.data) : null), [sessionsQuery.data]);
  const sessions = useMemo(() => {
    const list = [...(sessionsQuery.data ?? [])].sort((a, b) => b.lastUsedAt.localeCompare(a.lastUsedAt));
    const i = list.findIndex((s) => s._id === currentSessionId);
    if (i > 0) list.unshift(...list.splice(i, 1));
    return list;
  }, [sessionsQuery.data, currentSessionId]);

  async function handleRevoke(sessionId: string) {
    setRevoking(true);
    setSessionError(null);
    const ok = await revokeSession(sessionId).then(
      () => true,
      () => {
        setSessionError("Couldn't sign that device out. Try again.");
        return false;
      },
    );
    // The confirm promises "you'll be signed out here too" for this
    // device's session — previously the app carried on until the access
    // token expired (up to 15 min) and then logged out by surprise.
    if (ok && sessionId === currentSessionId) {
      logout();
      return;
    }
    queryClient.invalidateQueries({ queryKey: ["auth", "sessions"] });
    setRevoking(false);
    setRevokeTarget(null);
  }

  async function handleLogoutEverywhere() {
    setLoggingOutAll(true);
    setSessionError(null);
    try {
      // The response also set a new refresh cookie, replacing the one that just got
      // revoked along with every other session; only the access token is ours to store.
      const res = await logoutAllSessions();
      setAccessToken(res.access_token);
      queryClient.invalidateQueries({ queryKey: ["auth", "sessions"] });
    } catch {
      // The session list refetch will reflect whatever actually happened;
      // just say that this attempt didn't go through.
      setSessionError("Couldn't log out your other devices. Check your connection and try again.");
    } finally {
      setLoggingOutAll(false);
      setConfirmLogoutAllOpen(false);
    }
  }

  if (!user) return null;

  const fullName = [user.firstName, user.lastName].filter(Boolean).join(" ") || user.username;
  const pushBlocked = getStoredPushState().permission === "denied";

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-canvas">
      <PageHeader title="Settings" />

      <PageBody>
        <section aria-label="Your profile" className="flex flex-col items-center gap-4 rounded-[var(--radius-md)] border border-line bg-panel p-5 text-center sm:flex-row sm:items-center sm:text-start">
          <button
            type="button"
            onClick={() => setPhotosOpen(true)}
            aria-label={user.avatarUrl?.[0] ? "Profile photos" : "Add profile photo"}
            title={user.avatarUrl?.[0] ? "Profile photos" : "Add profile photo"}
            className="pressable relative shrink-0 rounded-full"
          >
            <Avatar colorId={user._id} name={fullName} src={user.avatarUrl?.[0]} size={80} />
            <span
              aria-hidden
              className="absolute -bottom-0.5 -end-0.5 flex size-8 items-center justify-center rounded-full bg-accent text-accent-fg"
              style={{ boxShadow: "0 0 0 3px var(--panel)" }}
            >
              <Camera className="size-4" strokeWidth={2.1} />
            </span>
          </button>
          <div className="min-w-0 max-w-full flex-1">
            <h2 dir="auto" className="truncate font-display text-[22px] font-bold leading-tight tracking-[-0.01em] text-fg">
              {fullName}
            </h2>
            <p className="mt-0.5 truncate text-[14px] text-muted">@{user.username}</p>
            {user.bio ? (
              <p dir="auto" className="mt-2 line-clamp-3 whitespace-pre-line break-words text-[14px] leading-relaxed text-fg-2">
                {user.bio}
              </p>
            ) : (
              <p className="mt-2 text-[14px] text-muted">No bio yet — add a line so people know it&apos;s you.</p>
            )}
          </div>
          <div className="flex w-full shrink-0 gap-2 sm:w-auto sm:flex-col">
            <Button variant="secondary" onClick={() => setEditProfileOpen(true)} className="flex-1">
              <Pencil className="size-4" strokeWidth={1.8} aria-hidden />
              Edit profile
            </Button>
            <Link href={`/app/user/${user._id}`} className={buttonClasses({ variant: "ghost", className: "flex-1" })}>
              <UserRound className="size-4" strokeWidth={1.8} aria-hidden />
              View profile
            </Link>
          </div>
        </section>

        <ListGroup title="Chats">
          <ListItem icon={ListFilter} title="Chat folders" subtitle="Organize chats into tabs" href="/app/settings/folders" />
          <ListItem
            icon={SmilePlus}
            title="Quick reaction"
            subtitle="Double-tap a message to react with this"
            onClick={() => setQuickReactionOpen(true)}
            trailing={
              <>
                <QuickReactionGlyph user={user} size={20} />
                <ChevronRight className="size-[18px] text-muted rtl:rotate-180" strokeWidth={1.8} aria-hidden />
              </>
            }
          />
          <ListItem icon={Sticker} title="Stickers & emoji" subtitle="Your packs, their order, and finding new ones" href="/app/settings/packs" />
          <ListItem icon={Bot} title="Bots" subtitle="Make your own sticker packs and more" href="/app/settings/bots" />
        </ListGroup>

        <ListGroup title="App">
          <InstallAppSettings />
        </ListGroup>

        <ListGroup title="Notifications">
          <ListItem
            icon={Bell}
            title="Push notifications"
            subtitle="When we send you a notification"
            onClick={() => setNotificationsOpen(true)}
            trailing={
              <>
                <span className="text-fg-2">{NOTIFICATION_LEVEL_LABEL[user.notificationLevel]}</span>
                <ChevronRight className="size-[18px] text-muted rtl:rotate-180" strokeWidth={1.8} aria-hidden />
              </>
            }
          />
          <ToastSettings />
          {isPushConfigured() ? (
            <div className="flex min-h-[60px] items-center gap-3 px-4 py-2.5">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-[var(--radius-sm)] bg-sunken text-fg-2">
                <BellRing className="size-[18px]" strokeWidth={1.8} aria-hidden />
              </span>
              <div className="min-w-0 flex-1">
                <div id={pushLabelId} className="text-[15px] font-medium text-fg">
                  Browser notifications
                </div>
                <div className="mt-0.5 text-[13px] leading-snug text-muted">{pushStatusText(pushEnabled)}</div>
                {pushError ? (
                  <p role="alert" className="mt-1 text-[13px] leading-snug text-danger">
                    {pushError}
                  </p>
                ) : null}
              </div>
              {pushPending ? <Spinner className="size-4" label="Updating browser notifications" /> : null}
              <Switch
                checked={pushEnabled}
                onChange={togglePush}
                disabled={pushPending || !isPushLikelySupported() || pushBlocked}
                aria-labelledby={pushLabelId}
              />
            </div>
          ) : null}
        </ListGroup>

        <ListGroup title="Preferences">
          <ListItem icon={Palette} title="Appearance" subtitle="Theme, wallpaper, motion &amp; performance" href="/app/settings/appearance" />
          <ListItem icon={Lock} title="Privacy and security" subtitle="Who can find you by username, phone or email" href="/app/settings/privacy" />
          <ListItem icon={UserX} title="Blocked users" subtitle="People you've blocked" href="/app/settings/blocked" />
        </ListGroup>

        <ListGroup title="Account">
          <ListItem icon={KeyRound} title="Change password" subtitle="Signs out your other devices" onClick={() => setChangePasswordOpen(true)} />
        </ListGroup>

        <ListGroup
          title="Signed-in devices"
          description={
            sessionError ? (
              <span role="alert" className="text-danger">
                {sessionError}
              </span>
            ) : (
              "Don't recognise a device? Sign it out, then change your password."
            )
          }
        >
          {sessionsQuery.isPending ? (
            <div role="status" aria-label="Loading devices">
              {[0, 1].map((i) => (
                <div key={i} aria-hidden className="flex min-h-[60px] items-center gap-3 px-4 py-2.5">
                  <Skeleton className="size-9 shrink-0 rounded-[var(--radius-sm)]" />
                  <div className="flex flex-1 flex-col gap-2">
                    <Skeleton className="h-3 w-2/5" />
                    <Skeleton className="h-2.5 w-3/5" />
                  </div>
                </div>
              ))}
            </div>
          ) : sessionsQuery.isError ? (
            <div className="flex min-h-[60px] items-center gap-3 px-4 py-2.5">
              <p className="flex-1 text-[14px] text-danger">Couldn&apos;t load your devices.</p>
              <Button size="sm" variant="secondary" onClick={() => sessionsQuery.refetch()}>
                Try again
              </Button>
            </div>
          ) : sessions.length === 0 ? (
            <div className="px-4 py-4 text-[14px] text-muted">No active sessions found.</div>
          ) : (
            sessions.map((s) => {
              const label = formatDeviceLabel(s.device);
              const isCurrent = s._id === currentSessionId;
              return (
                <ListItem
                  key={s._id}
                  icon={isMobileDevice(s.device) ? Smartphone : Monitor}
                  title={
                    <span className="flex min-w-0 items-center gap-2">
                      <span className="truncate">{label}</span>
                      {isCurrent ? (
                        <span className="shrink-0 rounded-full bg-accent-soft px-2 py-0.5 text-[12px] font-semibold text-accent-text">This device</span>
                      ) : null}
                    </span>
                  }
                  subtitle={
                    <span className="tabular">
                      Active {formatRelative(s.lastUsedAt)} · {s.ip}
                    </span>
                  }
                  // The current device signs out through Log out below, not here.
                  trailing={
                    isCurrent ? undefined : (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setRevokeTarget(s)}
                        aria-label={`Revoke ${label}`}
                        className="h-10 text-danger hover:bg-danger-soft hover:text-danger"
                      >
                        Revoke
                      </Button>
                    )
                  }
                />
              );
            })
          )}
          <ListItem
            icon={ShieldOff}
            title="Log out everywhere else"
            subtitle="Sign out every other device at once"
            onClick={() => setConfirmLogoutAllOpen(true)}
            disabled={loggingOutAll}
            trailing={loggingOutAll ? <Spinner className="size-4" label="Logging out other devices" /> : undefined}
          />
        </ListGroup>

        <ListGroup>
          <ListItem icon={LogOut} title="Log out" subtitle={`Signed in as @${user.username}`} onClick={() => setConfirmLogoutOpen(true)} />
        </ListGroup>


      </PageBody>

      {changePasswordOpen ? <ChangePasswordDialog onClose={() => setChangePasswordOpen(false)} /> : null}
      {editProfileOpen ? <EditProfileDialog onClose={() => setEditProfileOpen(false)} /> : null}
      {photosOpen ? <ProfilePhotosManager onClose={() => setPhotosOpen(false)} /> : null}
      {notificationsOpen ? <NotificationSettingsDialog onClose={() => setNotificationsOpen(false)} /> : null}
      {quickReactionOpen ? <QuickReactionDialog onClose={() => setQuickReactionOpen(false)} /> : null}

      {revokeTarget ? (
        <ConfirmDialog
          title={`Revoke ${formatDeviceLabel(revokeTarget.device)}?`}
          description={
            revokeTarget._id === currentSessionId
              ? "This looks like the device you're using now — you'll be signed out here too."
              : `Last active ${formatRelative(revokeTarget.lastUsedAt)}. It will be signed out and need your password to sign in again.`
          }
          confirmLabel="Revoke access"
          destructive
          pending={revoking}
          onConfirm={() => handleRevoke(revokeTarget._id)}
          onClose={() => (revoking ? undefined : setRevokeTarget(null))}
        />
      ) : null}

      {confirmLogoutAllOpen ? (
        <ConfirmDialog
          title="Log out everywhere else?"
          description="Every other phone, tablet and browser signed in to your account will be signed out. You stay signed in here."
          confirmLabel="Log out other devices"
          destructive
          pending={loggingOutAll}
          onConfirm={handleLogoutEverywhere}
          onClose={() => (loggingOutAll ? undefined : setConfirmLogoutAllOpen(false))}
        />
      ) : null}

      {confirmLogoutOpen ? (
        <ConfirmDialog
          title="Log out?"
          description="You'll need your password to sign back in on this device."
          confirmLabel="Log out"
          onConfirm={() => {
            setConfirmLogoutOpen(false);
            logout();
          }}
          onClose={() => setConfirmLogoutOpen(false)}
        />
      ) : null}
    </div>
  );
}
