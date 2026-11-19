"use client";

import { useId, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { Switch } from "@/components/ui/Switch";
import { clearMemberPermissions, setMemberPermissions, type MemberForManagement } from "@/lib/api/chats";
import { ApiError } from "@/lib/api/client";
import { MEMBER_PERMISSION_KEYS, type MemberPermissionKey, type MemberPermissions } from "@/lib/api/types";
import { chatManagementKey } from "@/hooks/use-chat-meta-events";
import { cn } from "@/lib/cn";

/** Plain labels for what members of a group may do. */
export const MEMBER_PERMISSION_COPY: Record<MemberPermissionKey, { label: string; hint: string }> = {
  sendMessages: { label: "Send messages", hint: "Write messages and replies" },
  sendMedia: { label: "Send photos, videos and files", hint: "Attach things from their device" },
  sendStickers: { label: "Send stickers and GIFs", hint: "From the sticker and GIF picker" },
  sendVoice: { label: "Send voice and video messages", hint: "Voice notes and round videos" },
  addMembers: { label: "Add members", hint: "Bring other people into the group" },
  pinMessages: { label: "Pin messages", hint: "Pin and unpin messages for everyone" },
  changeInfo: { label: "Change group info", hint: "Name, description and photo" },
};

/** The send rights only work while "Send messages" is on (the server enforces that too). */
export const NEEDS_SEND: ReadonlySet<MemberPermissionKey> = new Set(["sendMedia", "sendStickers", "sendVoice"]);

/** The member's exceptions applied over the group defaults. */
export function effectiveMemberPermissions(defaults: MemberPermissions, exceptions: Partial<MemberPermissions> | null | undefined): MemberPermissions {
  return { ...defaults, ...(exceptions ?? {}) };
}

/** Only the keys that are actually set (true or false). */
export function exceptionKeys(exceptions: Partial<MemberPermissions> | null | undefined): MemberPermissionKey[] {
  return MEMBER_PERMISSION_KEYS.filter((k) => typeof exceptions?.[k] === "boolean");
}

/** One labelled switch row, as used on the permissions screens. The whole
 *  label is the switch's name and the hint its description. */
export function RightSwitchRow({
  label,
  hint,
  checked,
  disabled,
  onChange,
  tag,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (value: boolean) => void;
  /** A small tag after the label, e.g. "Exception". */
  tag?: string;
}) {
  const labelId = useId();
  const hintId = useId();
  return (
    <div className={cn("flex min-h-[60px] items-center gap-3 px-4 py-2.5", disabled && "opacity-70")}>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span id={labelId} className="text-[15px] font-medium text-fg">
            {label}
          </span>
          {tag ? (
            <span className="inline-flex h-5 items-center rounded-full bg-accent-soft px-2 text-[12px] font-semibold text-accent-text">{tag}</span>
          ) : null}
        </div>
        {hint ? (
          <div id={hintId} className="mt-0.5 text-[13px] leading-snug text-muted">
            {hint}
          </div>
        ) : null}
      </div>
      <Switch checked={checked} onChange={onChange} disabled={disabled} aria-labelledby={labelId} aria-describedby={hint ? hintId : undefined} />
    </div>
  );
}

function personName(p: { firstName?: string; lastName?: string; username: string }) {
  return [p.firstName, p.lastName].filter(Boolean).join(" ") || p.username;
}

/** Exceptions for one group member: each switch shows what they can do now
 *  (the group default, or their own exception), and anything that differs
 *  from the default is saved as an exception. */
export function MemberPermissionsDialog({
  channelId,
  member,
  defaults,
  onClose,
}: {
  channelId: string;
  member: Pick<MemberForManagement, "userId" | "username" | "firstName" | "lastName" | "permissions">;
  defaults: MemberPermissions;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const name = personName(member);
  const [values, setValues] = useState<MemberPermissions>(() => effectiveMemberPermissions(defaults, member.permissions));
  const [error, setError] = useState<string | null>(null);
  const hadExceptions = exceptionKeys(member.permissions).length > 0;

  const diff: Partial<MemberPermissions> = {};
  for (const k of MEMBER_PERMISSION_KEYS) if (values[k] !== defaults[k]) diff[k] = values[k];
  const diffCount = Object.keys(diff).length;

  function patchCache(permissions: Partial<MemberPermissions> | null) {
    queryClient.setQueryData<MemberForManagement[]>(chatManagementKey(channelId), (prev) =>
      prev?.map((m) => (m.userId === member.userId ? { ...m, permissions, mutedByAdmin: permissions?.sendMessages === false } : m)),
    );
    queryClient.invalidateQueries({ queryKey: chatManagementKey(channelId) });
  }

  const saveMutation = useMutation({
    mutationFn: () => (diffCount === 0 ? clearMemberPermissions(channelId, member.userId) : setMemberPermissions(channelId, member.userId, diff)),
    onMutate: () => setError(null),
    onSuccess: () => {
      patchCache(diffCount === 0 ? null : diff);
      onClose();
    },
    onError: (err) => setError(err instanceof ApiError && err.status < 500 ? err.message : "Couldn't save. Check your connection and try again."),
  });

  const resetMutation = useMutation({
    mutationFn: () => clearMemberPermissions(channelId, member.userId),
    onMutate: () => setError(null),
    onSuccess: () => {
      patchCache(null);
      onClose();
    },
    onError: (err) => setError(err instanceof ApiError && err.status < 500 ? err.message : "Couldn't reset. Check your connection and try again."),
  });

  const pending = saveMutation.isPending || resetMutation.isPending;

  return (
    <Dialog
      onClose={onClose}
      dismissible={!pending}
      size="md"
      title={`What ${name} can do`}
      description="Switches that differ from the group's settings are exceptions just for them."
      onSubmit={() => saveMutation.mutate()}
      bodyClassName="px-0 py-0"
      footer={
        <>
          {hadExceptions || diffCount > 0 ? (
            <Button type="button" variant="ghost" className="sm:me-auto" disabled={pending} loading={resetMutation.isPending} onClick={() => resetMutation.mutate()}>
              Reset to group defaults
            </Button>
          ) : null}
          <Button type="button" variant="secondary" disabled={pending} onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={saveMutation.isPending} disabled={pending}>
            Save
          </Button>
        </>
      }
    >
      <div className="divide-y divide-line border-y border-line">
        {MEMBER_PERMISSION_KEYS.map((k) => {
          const blocked = NEEDS_SEND.has(k) && !values.sendMessages;
          return (
            <RightSwitchRow
              key={k}
              label={MEMBER_PERMISSION_COPY[k].label}
              hint={blocked ? "Needs “Send messages”" : MEMBER_PERMISSION_COPY[k].hint}
              checked={blocked ? false : values[k]}
              disabled={blocked || pending}
              tag={values[k] !== defaults[k] ? "Exception" : undefined}
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
  );
}
