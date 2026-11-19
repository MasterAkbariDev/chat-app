"use client";

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog, Dialog } from "@/components/ui/Dialog";
import { RightSwitchRow } from "@/components/chat/MemberPermissionsDialog";
import { CHANNELS_QUERY_KEY, setAdmin, setAdminRights, type MemberForManagement } from "@/lib/api/chats";
import { ApiError } from "@/lib/api/client";
import { ADMIN_RIGHT_KEYS, type AdminRightKey, type AdminRights, type ChatKind, type EffectivePermissions } from "@/lib/api/types";
import { chatManagementKey, chatParticipantsKey } from "@/hooks/use-chat-meta-events";

/** What a new admin gets unless changed (the server's default too). */
export const DEFAULT_ADMIN_RIGHTS: AdminRights = {
  changeInfo: true,
  deleteMessages: true,
  banUsers: true,
  inviteUsers: true,
  pinMessages: true,
  addAdmins: false,
  postMessages: true,
  editMessages: true,
};

export function adminRightCopy(key: AdminRightKey, kind: ChatKind | undefined): { label: string; hint: string } {
  const channel = kind === "channel";
  switch (key) {
    case "changeInfo":
      return { label: channel ? "Change channel info" : "Change group info", hint: "Name, description and photo" };
    case "postMessages":
      return { label: "Post messages", hint: "Publish new posts in the channel" };
    case "editMessages":
      return { label: "Edit others' posts", hint: "Change posts written by other admins" };
    case "deleteMessages":
      return { label: "Delete messages", hint: channel ? "Remove anyone's posts" : "Remove anyone's messages for everyone" };
    case "banUsers":
      return channel
        ? { label: "Ban subscribers", hint: "Remove people and keep them out" }
        : { label: "Ban and restrict members", hint: "Remove people, mute them and set what members can do" };
    case "inviteUsers":
      return { label: "Invite people", hint: "Add people and manage the invite link" };
    case "pinMessages":
      return { label: "Pin messages", hint: "Pin and unpin messages for everyone" };
    case "addAdmins":
      return { label: "Add new admins", hint: "Make others admins with rights they have themselves" };
  }
}

/** The rights that mean something in this kind of chat, in display order. */
export function relevantAdminRights(kind: ChatKind | undefined): AdminRightKey[] {
  return kind === "channel"
    ? ["changeInfo", "postMessages", "editMessages", "deleteMessages", "banUsers", "inviteUsers", "pinMessages", "addAdmins"]
    : ["changeInfo", "deleteMessages", "banUsers", "inviteUsers", "pinMessages", "addAdmins"];
}

/** "5 of 6 rights" */
export function adminRightsSummary(rights: AdminRights | null | undefined, kind: ChatKind | undefined) {
  const keys = relevantAdminRights(kind);
  const on = keys.filter((k) => rights?.[k]).length;
  return `${on} of ${keys.length} rights`;
}

/** Whether I may edit or remove this admin: the owner can change anyone; an
 *  admin with "Add new admins" only the admins they appointed. */
export function canManageAdmin(my: EffectivePermissions | undefined, myId: string | undefined, target: { role: string; promotedBy: string | null; userId: string }) {
  if (!my?.admin.addAdmins || !myId || target.userId === myId || target.role === "owner") return false;
  if (target.role !== "admin") return true;
  return my.role === "owner" || target.promotedBy === myId;
}

function personName(p: { firstName?: string; lastName?: string; username: string }) {
  return [p.firstName, p.lastName].filter(Boolean).join(" ") || p.username;
}

/** Promote someone to admin, or change an admin's rights. Rights you don't
 *  hold yourself are shown but locked; the server keeps their current value. */
export function AdminRightsDialog({
  channelId,
  chatType,
  member,
  my,
  onClose,
}: {
  channelId: string;
  chatType: ChatKind | undefined;
  member: Pick<MemberForManagement, "userId" | "username" | "firstName" | "lastName" | "role" | "adminRights">;
  my: EffectivePermissions;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const name = personName(member);
  const isPromotion = member.role !== "admin";
  const iAmOwner = my.role === "owner";
  const holds = (k: AdminRightKey) => iAmOwner || my.admin[k];
  const [values, setValues] = useState<AdminRights>(() => {
    const base = isPromotion ? DEFAULT_ADMIN_RIGHTS : { ...DEFAULT_ADMIN_RIGHTS, ...(member.adminRights ?? {}) };
    // A new admin can't start with a right their appointer lacks.
    return Object.fromEntries(ADMIN_RIGHT_KEYS.map((k) => [k, isPromotion ? base[k] && holds(k) : base[k]])) as AdminRights;
  });
  const [error, setError] = useState<string | null>(null);
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const keys = relevantAdminRights(chatType);

  function refresh() {
    queryClient.invalidateQueries({ queryKey: chatManagementKey(channelId) });
    queryClient.invalidateQueries({ queryKey: chatParticipantsKey(channelId) });
    queryClient.invalidateQueries({ queryKey: CHANNELS_QUERY_KEY });
  }

  function errorText(err: unknown) {
    return err instanceof ApiError && err.status < 500 ? err.message : "Couldn't save. Check your connection and try again.";
  }

  const saveMutation = useMutation({
    mutationFn: () => setAdminRights(channelId, member.userId, values),
    onMutate: () => setError(null),
    onSuccess: (res) => {
      queryClient.setQueryData<MemberForManagement[]>(chatManagementKey(channelId), (prev) =>
        prev?.map((m) => (m.userId === member.userId ? { ...m, role: "admin", adminRights: res.adminRights, permissions: null, mutedByAdmin: false } : m)),
      );
      refresh();
      onClose();
    },
    onError: (err) => setError(errorText(err)),
  });

  const removeMutation = useMutation({
    mutationFn: () => setAdmin(channelId, member.userId, false),
    onSuccess: () => {
      queryClient.setQueryData<MemberForManagement[]>(chatManagementKey(channelId), (prev) =>
        prev?.map((m) => (m.userId === member.userId ? { ...m, role: "member", adminRights: null, promotedBy: null } : m)),
      );
      refresh();
      setConfirmingRemove(false);
      onClose();
    },
    onError: (err) => {
      setConfirmingRemove(false);
      setError(err instanceof ApiError && err.status < 500 ? err.message : "Couldn't remove them as admin. Check your connection and try again.");
    },
  });

  const pending = saveMutation.isPending || removeMutation.isPending;

  return (
    <>
      <Dialog
        onClose={onClose}
        dismissible={!pending}
        size="md"
        title={isPromotion ? `Make ${name} an admin` : `${name}'s admin rights`}
        description={isPromotion ? "Choose what they can do. You can change this later." : "Choose what this admin can do."}
        onSubmit={() => saveMutation.mutate()}
        bodyClassName="px-0 py-0"
        footer={
          <>
            {!isPromotion ? (
              <Button type="button" variant="danger-soft" className="sm:me-auto" disabled={pending} onClick={() => setConfirmingRemove(true)}>
                Remove admin
              </Button>
            ) : null}
            <Button type="button" variant="secondary" disabled={pending} onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" loading={saveMutation.isPending} disabled={pending}>
              {isPromotion ? "Make admin" : "Save"}
            </Button>
          </>
        }
      >
        <div className="divide-y divide-line border-y border-line">
          {keys.map((k) => {
            const copy = adminRightCopy(k, chatType);
            const locked = !holds(k);
            return (
              <RightSwitchRow
                key={k}
                label={copy.label}
                hint={locked ? "You don't have this right" : copy.hint}
                checked={values[k]}
                disabled={locked || pending}
                onChange={(v) => setValues((prev) => ({ ...prev, [k]: v }))}
              />
            );
          })}
        </div>
        {error ? (
          <p role="alert" className="mx-5 my-3 rounded-[var(--radius-sm)] bg-danger-soft px-3 py-2 text-[13.5px] text-danger">
            {error}
          </p>
        ) : null}
      </Dialog>

      {confirmingRemove ? (
        <ConfirmDialog
          title={`Remove ${name} as admin?`}
          description="They'll stay in the chat as a regular member and lose all admin rights."
          confirmLabel="Remove admin"
          destructive
          pending={removeMutation.isPending}
          onConfirm={() => removeMutation.mutate()}
          onClose={() => setConfirmingRemove(false)}
        />
      ) : null}
    </>
  );
}
