"use client";

import { useState } from "react";
import { useRouter } from "@/hooks/use-app-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Lock, MessageCircle, MoreHorizontal, Pencil, Search, Trash2, UserPlus, UserRound, Users } from "lucide-react";
import { Avatar } from "@/components/ui/Avatar";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog, Dialog } from "@/components/ui/Dialog";
import { EmptyState } from "@/components/ui/EmptyState";
import { Field, Input } from "@/components/ui/Field";
import { IconButton } from "@/components/ui/IconButton";
import { Menu, useMenuState } from "@/components/ui/Menu";
import { PageBody, PageHeader } from "@/components/ui/PageHeader";
import { SegmentedTabs } from "@/components/ui/SegmentedTabs";
import { SkeletonList } from "@/components/ui/Skeleton";
import { Spinner } from "@/components/ui/Spinner";
import { addContact, getContacts, removeContact, renameContact, type ContactIdentifier } from "@/lib/api/contacts";
import { CHANNELS_QUERY_KEY, getOrCreateDirect } from "@/lib/api/chats";
import { ApiError } from "@/lib/api/client";
import type { ContactSummary } from "@/lib/api/types";

const CONTACTS_QUERY_KEY = ["contacts"] as const;

type IdentifierKind = "username" | "phone" | "email";

const KIND_FIELD: Record<IdentifierKind, { label: string; placeholder: string; hint: string; type: string; inputMode: "text" | "tel" | "email" }> = {
  username: { label: "Username", placeholder: "maya", hint: "Their exact username, without the @.", type: "text", inputMode: "text" },
  phone: { label: "Phone number", placeholder: "+1 555 010 0000", hint: "Include the country code, e.g. +44.", type: "tel", inputMode: "tel" },
  email: { label: "Email address", placeholder: "name@example.com", hint: "The email they signed up with.", type: "email", inputMode: "email" },
};

function formatRelative(iso: string): string {
  // Calendar days, not rounded 24h spans — a message from 14 hours ago this
  // morning is "today", not "yesterday".
  const then = new Date(iso);
  const now = new Date();
  const days = Math.round(
    (new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() -
      new Date(then.getFullYear(), then.getMonth(), then.getDate()).getTime()) /
      86_400_000,
  );
  if (days < 1) return "today";
  if (days === 1) return "yesterday";
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function contactName(contact: ContactSummary) {
  return contact.customName || [contact.user.firstName, contact.user.lastName].filter(Boolean).join(" ") || contact.user.username;
}

export default function ContactsPage() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [addOpen, setAddOpen] = useState(false);
  const [kind, setKind] = useState<IdentifierKind>("username");
  const [identifier, setIdentifier] = useState("");
  const [addError, setAddError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<ContactSummary | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [removing, setRemoving] = useState<ContactSummary | null>(null);
  const [openingId, setOpeningId] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [chatError, setChatError] = useState<string | null>(null);

  const contactsQuery = useQuery({ queryKey: CONTACTS_QUERY_KEY, queryFn: getContacts });

  const addMutation = useMutation({
    mutationFn: (input: ContactIdentifier) => addContact(input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: CONTACTS_QUERY_KEY });
      // A profile's phone/email visibility depends on contact status.
      queryClient.invalidateQueries({ queryKey: ["users", "profile"] });
      setAddOpen(false);
      setIdentifier("");
      setAddError(null);
    },
    // A 404 is the same whether nobody has that identifier or their privacy
    // settings hide them from you — say so without implying either.
    onError: (err) =>
      setAddError(
        err instanceof ApiError
          ? err.status === 404
            ? "No one found. Check it and try again — some people only let their contacts find them."
            : err.message
          : "Couldn't add them. Check your connection and try again.",
      ),
  });

  const removeMutation = useMutation({
    mutationFn: (contactId: string) => removeContact(contactId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: CONTACTS_QUERY_KEY });
      queryClient.invalidateQueries({ queryKey: ["users", "profile"] });
      setRemoving(null);
    },
  });

  const renameMutation = useMutation({
    mutationFn: ({ contactId, customName }: { contactId: string; customName: string | null }) => renameContact(contactId, customName),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: CONTACTS_QUERY_KEY });
      setRenaming(null);
    },
  });

  function handleAddSubmit() {
    // People naturally type "@maya" for a username.
    const trimmed = kind === "username" ? identifier.trim().replace(/^@+/, "") : identifier.trim();
    if (!trimmed) {
      setAddError(`Enter their ${KIND_FIELD[kind].label.toLowerCase()}.`);
      return;
    }
    setAddError(null);
    if (kind === "username") addMutation.mutate({ username: trimmed });
    else if (kind === "phone") addMutation.mutate({ phone: trimmed });
    else addMutation.mutate({ email: trimmed });
  }

  async function handleChat(contact: ContactSummary) {
    if (contact.channelId) {
      router.push(`/app/c/${contact.channelId}`);
      return;
    }
    setOpeningId(contact._id);
    setChatError(null);
    try {
      const chat = await getOrCreateDirect(contact.user._id);
      await queryClient.invalidateQueries({ queryKey: CHANNELS_QUERY_KEY });
      router.push(`/app/c/${chat._id}`);
    } catch (err) {
      setChatError(err instanceof ApiError ? err.message : `Couldn't open your chat with ${contactName(contact)}. Check your connection and try again.`);
    } finally {
      setOpeningId(null);
    }
  }

  function startRename(contact: ContactSummary) {
    renameMutation.reset();
    setRenaming(contact);
    setRenameValue(contact.customName ?? "");
  }

  function openAdd() {
    setAddError(null);
    setAddOpen(true);
  }

  const contacts = contactsQuery.data ?? [];
  const needle = filter.trim().toLowerCase();
  const visible = needle
    ? contacts.filter((c) => contactName(c).toLowerCase().includes(needle) || c.user.username.toLowerCase().includes(needle))
    : contacts;
  const field = KIND_FIELD[kind];

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-canvas">
      <PageHeader
        title="Contacts"
        subtitle={contactsQuery.isSuccess && contacts.length > 0 ? `${contacts.length} ${contacts.length === 1 ? "person" : "people"}` : undefined}
        actions={
          <Button size="sm" onClick={openAdd}>
            <UserPlus className="size-[18px]" strokeWidth={2} aria-hidden />
            Add contact
          </Button>
        }
      />

      <PageBody className="gap-4">
        {contacts.length > 0 ? (
          <div className="relative">
            <Search className="pointer-events-none absolute start-3.5 top-1/2 size-[18px] -translate-y-1/2 text-muted" strokeWidth={1.8} aria-hidden />
            <Input
              type="search"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Search contacts"
              aria-label="Search contacts"
              autoComplete="off"
              className="ps-10"
            />
          </div>
        ) : null}

        {chatError ? (
          <p role="alert" className="rounded-[var(--radius-sm)] bg-danger-soft px-3 py-2 text-[13.5px] text-danger">
            {chatError}
          </p>
        ) : null}

        {contactsQuery.isPending ? (
          <div className="overflow-hidden rounded-[var(--radius-md)] border border-line bg-panel">
            <SkeletonList count={5} />
          </div>
        ) : contactsQuery.isError ? (
          <EmptyState
            icon={Users}
            title="Couldn't load contacts"
            description="Check your connection, then try again."
            action={{ label: "Try again", onClick: () => contactsQuery.refetch() }}
          />
        ) : contacts.length === 0 ? (
          <EmptyState
            icon={Users}
            title="No contacts yet"
            description="Add people by their username, phone number or email to message them quickly."
            action={{ label: "Add a contact", onClick: openAdd }}
          />
        ) : visible.length === 0 ? (
          <p className="py-6 text-center text-[14px] text-muted">No contacts match “{filter.trim()}”.</p>
        ) : (
          <ul className="overflow-hidden rounded-[var(--radius-md)] border border-line bg-panel [&>*+*]:border-t [&>*+*]:border-line">
            {visible.map((contact) => (
              <ContactRow
                key={contact._id}
                contact={contact}
                opening={openingId === contact._id}
                onChat={() => handleChat(contact)}
                onProfile={() => router.push(`/app/user/${contact.user._id}`)}
                onRename={() => startRename(contact)}
                onRemove={() => {
                  removeMutation.reset();
                  setRemoving(contact);
                }}
              />
            ))}
          </ul>
        )}

        {contacts.length > 0 ? (
          <p className="flex items-start gap-2 px-1 text-[13px] leading-relaxed text-muted">
            <Lock className="mt-0.5 size-3.5 shrink-0" strokeWidth={1.9} aria-hidden />
            Phone numbers and emails stay hidden on profiles unless you&apos;ve both added each other.
          </p>
        ) : null}
      </PageBody>

      {addOpen ? (
        <Dialog
          onClose={() => setAddOpen(false)}
          title="Add a contact"
          description="Find someone by their exact username, phone number or email."
          onSubmit={handleAddSubmit}
          bodyClassName="flex flex-col gap-4 pb-4"
          footer={
            <>
              <Button variant="secondary" onClick={() => setAddOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" loading={addMutation.isPending}>
                Add contact
              </Button>
            </>
          }
        >
          <SegmentedTabs<IdentifierKind>
            aria-label="Find them by"
            options={[
              { key: "username", label: "Username" },
              { key: "phone", label: "Phone" },
              { key: "email", label: "Email" },
            ]}
            value={kind}
            onChange={(next) => {
              setKind(next);
              setAddError(null);
            }}
          />
          <Field label={field.label} hint={field.hint} error={addError ?? undefined}>
            <Input
              key={kind}
              value={identifier}
              onChange={(e) => {
                setIdentifier(e.target.value);
                if (addError) setAddError(null);
              }}
              type={field.type}
              inputMode={field.inputMode}
              placeholder={field.placeholder}
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              data-autofocus
            />
          </Field>
        </Dialog>
      ) : null}

      {renaming ? (
        <Dialog
          onClose={() => setRenaming(null)}
          title="Rename contact"
          description="Only you see this name. Leave it empty to use their own name."
          onSubmit={() => renameMutation.mutate({ contactId: renaming._id, customName: renameValue.trim() || null })}
          bodyClassName="pb-4"
          footer={
            <>
              <Button variant="secondary" onClick={() => setRenaming(null)}>
                Cancel
              </Button>
              <Button type="submit" loading={renameMutation.isPending}>
                Save name
              </Button>
            </>
          }
        >
          <Field
            label="Name"
            error={
              renameMutation.isError
                ? renameMutation.error instanceof ApiError
                  ? renameMutation.error.message
                  : "Couldn't save the name. Check your connection and try again."
                : undefined
            }
          >
            <Input
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              placeholder={[renaming.user.firstName, renaming.user.lastName].filter(Boolean).join(" ") || renaming.user.username}
              autoComplete="off"
              data-autofocus
            />
          </Field>
        </Dialog>
      ) : null}

      {removing ? (
        <ConfirmDialog
          title={`Remove ${contactName(removing)}?`}
          description={
            <>
              They&apos;ll leave your contacts. Your chat with them stays, and you can add them again anytime.
              {removeMutation.isError ? (
                <span role="alert" className="mt-2 block text-danger">
                  Couldn&apos;t remove them. Check your connection and try again.
                </span>
              ) : null}
            </>
          }
          confirmLabel="Remove contact"
          destructive
          pending={removeMutation.isPending}
          onConfirm={() => removeMutation.mutate(removing._id)}
          onClose={() => setRemoving(null)}
        />
      ) : null}
    </div>
  );
}

function ContactRow({
  contact,
  opening,
  onChat,
  onProfile,
  onRename,
  onRemove,
}: {
  contact: ContactSummary;
  opening: boolean;
  onChat: () => void;
  onProfile: () => void;
  onRename: () => void;
  onRemove: () => void;
}) {
  const menu = useMenuState();
  const name = contactName(contact);
  const meta = [
    `@${contact.user.username}`,
    contact.lastMessagePreview ?? null,
    contact.lastMessageAt ? formatRelative(contact.lastMessageAt) : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <li className="flex items-center gap-1 pe-2">
      <button
        type="button"
        onClick={onChat}
        disabled={opening}
        className="focus-inset flex min-h-[68px] min-w-0 flex-1 items-center gap-3 px-4 py-2.5 text-start transition-colors duration-[var(--dur-fast)] hover:bg-sunken disabled:opacity-70"
      >
        <Avatar colorId={contact.user._id} name={name} src={contact.user.avatarUrl?.[0]} size={48} presence={contact.isOnline ? "online" : "none"} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[15px] font-semibold text-fg">
            <span className="sr-only">Message </span>
            {name}
          </span>
          <span className="block truncate text-[13.5px] text-muted">
            {contact.isOnline ? <span className="text-success">Online · </span> : null}
            {meta}
          </span>
        </span>
        {opening ? <Spinner label="Opening chat" /> : null}
      </button>
      <IconButton aria-label={`Options for ${name}`} aria-haspopup="menu" aria-expanded={menu.open} onClick={(e) => menu.openFrom(e.currentTarget)}>
        <MoreHorizontal strokeWidth={2} />
      </IconButton>
      {menu.anchor ? (
        <Menu
          anchor={menu.anchor}
          aria-label={`Options for ${name}`}
          onClose={menu.close}
          items={[
            { key: "message", label: "Message", icon: MessageCircle, onSelect: onChat },
            { key: "profile", label: "View profile", icon: UserRound, onSelect: onProfile },
            { key: "rename", label: "Rename", icon: Pencil, onSelect: onRename },
            { key: "sep", separator: true },
            { key: "remove", label: "Remove contact", icon: Trash2, danger: true, onSelect: onRemove },
          ]}
        />
      ) : null}
    </li>
  );
}
