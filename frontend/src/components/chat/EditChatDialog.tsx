"use client";

import { chatPreviewKey } from "@/hooks/use-chat-meta-events";
import { useId, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { Field, Input, Textarea } from "@/components/ui/Field";
import { PhotoPicker } from "@/components/ui/PhotoPicker";
import { SegmentedTabs } from "@/components/ui/SegmentedTabs";
import { Skeleton } from "@/components/ui/Skeleton";
import { Switch } from "@/components/ui/Switch";
import { CHANNELS_QUERY_KEY, getChatPreview, updateChat, type UpdateChatInput } from "@/lib/api/chats";
import { ApiError } from "@/lib/api/client";
import type { ChatPreview } from "@/lib/api/types";

export interface EditChatDialogProps {
  open: boolean;
  onClose: () => void;
  channelId: string;
  myRole: "owner" | "admin" | "member";
}

export const CHAT_LINK_PATTERN = /^[a-zA-Z0-9_-]{3,64}$/;
export const CHAT_LINK_HINT = "3–64 letters, numbers, underscores or hyphens.";
const DESCRIPTION_MAX = 1000;

type Visibility = "public" | "private";

/** Edit a group's or channel's photo, name and description (owner or admin);
 *  the owner can also make it public (searchable, with an @link) or private. */
export function EditChatDialog({ open, onClose, channelId, myRole }: EditChatDialogProps) {
  const previewQuery = useQuery({
    queryKey: chatPreviewKey(channelId),
    queryFn: () => getChatPreview(channelId),
    enabled: open,
  });

  if (!open) return null;

  if (!previewQuery.data) {
    return (
      <Dialog onClose={onClose} title="Edit">
        {previewQuery.isError ? (
          <div className="flex flex-col items-start gap-3">
            <p role="alert" className="text-[14px] text-danger">
              Couldn&apos;t load the current details. Check your connection and try again.
            </p>
            <Button variant="secondary" onClick={() => previewQuery.refetch()}>
              Try again
            </Button>
          </div>
        ) : (
          <div role="status" aria-label="Loading" className="flex flex-col items-center gap-4">
            <Skeleton className="size-[88px] rounded-[30%]" />
            <Skeleton className="h-11 w-full rounded-[var(--radius-sm)]" />
            <Skeleton className="h-[88px] w-full rounded-[var(--radius-sm)]" />
          </div>
        )}
      </Dialog>
    );
  }

  // Keyed so the form's local state starts from the loaded values.
  return <EditChatForm key={previewQuery.data._id} chat={previewQuery.data} channelId={channelId} myRole={myRole} onClose={onClose} />;
}

function EditChatForm({ chat, channelId, myRole, onClose }: { chat: ChatPreview; channelId: string; myRole: EditChatDialogProps["myRole"]; onClose: () => void }) {
  const queryClient = useQueryClient();
  const isOwner = myRole === "owner";
  const kindLabel = chat.type === "channel" ? "channel" : "group";
  const initialPhoto = chat.image?.[0] ?? null;

  const [photo, setPhoto] = useState<string | null>(initialPhoto);
  const [uploading, setUploading] = useState(false);
  const [name, setName] = useState(chat.name ?? "");
  const [description, setDescription] = useState(chat.description ?? "");
  const [visibility, setVisibility] = useState<Visibility>(chat.isPublic ? "public" : "private");
  const [link, setLink] = useState(chat.isPublic ? (chat.link ?? "") : "");
  const [signature, setSignature] = useState(!!chat.signature);
  const signatureId = useId();
  const [nameError, setNameError] = useState<string | null>(null);
  const [linkError, setLinkError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const visibilityHintId = useId();

  const mutation = useMutation({
    mutationFn: (input: UpdateChatInput) => updateChat(channelId, input),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: CHANNELS_QUERY_KEY }),
        queryClient.invalidateQueries({ queryKey: chatPreviewKey(channelId) }),
      ]);
      onClose();
    },
    onError: (err) => {
      const message = err instanceof ApiError && err.message ? err.message : "Couldn't save the changes. Check your connection and try again.";
      // A taken or invalid link is the usual 4xx here — show it on the field.
      const status = err instanceof ApiError ? err.status : 0;
      if (isOwner && visibility === "public" && (status === 409 || /link|already|taken/i.test(message))) {
        setLinkError(status === 409 || /already|taken/i.test(message) ? "That link is already taken. Try another one." : message);
      } else setError(message);
    },
  });

  function submit() {
    if (mutation.isPending || uploading) return;
    setError(null);
    setNameError(null);
    setLinkError(null);

    const trimmedName = name.trim();
    if (!trimmedName) {
      setNameError(`Give your ${kindLabel} a name.`);
      return;
    }
    const input: UpdateChatInput = {};
    if (trimmedName !== chat.name) input.name = trimmedName;
    if (description !== (chat.description ?? "")) input.description = description;
    if (photo !== initialPhoto) input.imageUrl = photo ? [photo] : [];
    if (chat.type === "channel" && signature !== !!chat.signature) input.signature = signature;

    if (isOwner) {
      const makePublic = visibility === "public";
      if (makePublic) {
        const trimmedLink = link.trim().replace(/^@/, "");
        if (!CHAT_LINK_PATTERN.test(trimmedLink)) {
          setLinkError(trimmedLink ? `The link can use ${CHAT_LINK_HINT.toLowerCase()}` : "A public link is needed so people can find it.");
          return;
        }
        if (trimmedLink !== chat.link) input.link = trimmedLink;
      }
      if (makePublic !== chat.isPublic) input.isPublic = makePublic;
    }

    if (Object.keys(input).length === 0) {
      onClose();
      return;
    }
    mutation.mutate(input);
  }

  return (
    <Dialog
      onClose={onClose}
      onSubmit={submit}
      title={`Edit ${kindLabel}`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={mutation.isPending} disabled={uploading}>
            Save changes
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <PhotoPicker
          value={photo}
          onChange={setPhoto}
          onUploadingChange={setUploading}
          name={name.trim() || chat.name}
          colorId={channelId}
          shape="square"
          size={88}
        />

        {chat.type === "channel" ? (
          <div className="flex items-center justify-between gap-4">
            <div className="flex min-w-0 flex-col gap-0.5">
              <span id={signatureId} className="text-[15px] text-fg">
                Sign posts
              </span>
              <span className="text-[12.5px] leading-snug text-muted">Show each post&apos;s author name next to the time. Only the name is shown.</span>
            </div>
            <Switch checked={signature} onChange={setSignature} aria-labelledby={signatureId} />
          </div>
        ) : null}

        <Field label={chat.type === "channel" ? "Channel name" : "Group name"} error={nameError ?? undefined}>
          <Input
            value={name}
            maxLength={100}
            onChange={(e) => {
              setName(e.target.value);
              if (nameError) setNameError(null);
            }}
            autoComplete="off"
            required
          />
        </Field>

        <Field
          label="Description"
          labelAside={
            <span className="tabular text-[12.5px] text-muted" aria-live="polite">
              {description.length}/{DESCRIPTION_MAX}
            </span>
          }
        >
          <Textarea
            value={description}
            onChange={(e) => setDescription(e.target.value.slice(0, DESCRIPTION_MAX))}
            rows={3}
            dir="auto"
            placeholder={`What's this ${kindLabel} about?`}
          />
        </Field>

        {isOwner ? (
          <div className="flex flex-col gap-2">
            <span className="text-[13.5px] font-semibold text-fg-2">Who can join</span>
            <SegmentedTabs<Visibility>
              aria-label="Who can join"
              options={[
                { key: "private", label: "Private" },
                { key: "public", label: "Public" },
              ]}
              value={visibility}
              onChange={(v) => {
                setVisibility(v);
                setLinkError(null);
              }}
            />
            <p id={visibilityHintId} className="text-[12.5px] leading-snug text-muted">
              Public: anyone can find it in search and join. Private: people join with an invite link.
            </p>
          </div>
        ) : null}

        {isOwner && visibility === "public" ? (
          <Field label="Public link" hint={`People can find it as @link. ${CHAT_LINK_HINT}`} error={linkError ?? undefined}>
            <LinkInput
              value={link}
              onChange={(v) => {
                setLink(v);
                if (linkError) setLinkError(null);
              }}
            />
          </Field>
        ) : null}

        {error ? (
          <p role="alert" className="text-[13.5px] text-danger">
            {error}
          </p>
        ) : null}
      </div>
    </Dialog>
  );
}

/** A text input with a fixed "@" prefix. Forwards the id/aria props `Field` injects. */
export function LinkInput({
  value,
  onChange,
  ...rest
}: { value: string; onChange: (value: string) => void; id?: string; "aria-describedby"?: string; "aria-invalid"?: boolean }) {
  return (
    <div className="relative">
      <span aria-hidden className="pointer-events-none absolute inset-y-0 start-3.5 flex items-center text-[15px] text-muted">
        @
      </span>
      <Input
        {...rest}
        value={value}
        onChange={(e) => onChange(e.target.value.replace(/^@/, "").replace(/\s+/g, ""))}
        className="ps-8"
        dir="ltr"
        maxLength={64}
        autoComplete="off"
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        placeholder="team-news"
      />
    </div>
  );
}
