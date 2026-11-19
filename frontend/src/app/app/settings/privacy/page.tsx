"use client";

import { useState } from "react";

import { AtSign, Clock, Forward, Image as ImageIcon, Info, Mail, Phone, PhoneCall, Search, Trash2, UserX, Users, type LucideIcon } from "lucide-react";
import { DeleteAccountDialog } from "@/components/settings/DeleteAccountDialog";
import { Button } from "@/components/ui/Button";
import { ListGroup, ListItem } from "@/components/ui/List";
import { PageBody, PageHeader } from "@/components/ui/PageHeader";
import { SkeletonList } from "@/components/ui/Skeleton";
import { AUDIENCE_LABEL, PRIVACY_META, PRIVACY_SECTIONS, ruleSummary } from "@/components/settings/privacy/privacy-meta";
import { usePrivacyRules } from "@/components/settings/privacy/use-privacy";
import { useAuth } from "@/contexts/auth-context";
import { DEFAULT_PRIVACY } from "@/lib/api/users";
import type { PrivacyKey } from "@/lib/api/types";

const ICONS: Record<PrivacyKey, LucideIcon> = {
  phoneNumber: Phone,
  email: Mail,
  lastSeen: Clock,
  profilePhotos: ImageIcon,
  bio: Info,
  calls: PhoneCall,
  groupInvites: Users,
  forwards: Forward,
  findByUsername: AtSign,
  findByPhoneOrEmail: Search,
};

/** Settings → Privacy and security: Telegram's list. Each row shows the
 * current choice ("My contacts (−1, +2)") and opens its own page. */
export default function PrivacySettingsPage() {
  const { user } = useAuth();
  const { query, rules } = usePrivacyRules();
  const [deleteAccountOpen, setDeleteAccountOpen] = useState(false);

  if (!user) return null;
  // Until the full rules load, rows show the audiences `me` already knows.
  const audiences = { ...DEFAULT_PRIVACY, ...user.privacy };

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-canvas">
      <PageHeader title="Privacy and security" backHref="/app/settings" backLabel="Back to settings" backOnDesktop />

      <PageBody>
        {query.isError && !rules ? (
          <div role="alert" className="flex items-center justify-between gap-3 rounded-[var(--radius-sm)] bg-danger-soft px-3 py-2 text-[13.5px] text-danger">
            <span>Couldn&apos;t load your exceptions. The choices below may be incomplete.</span>
            <Button size="sm" variant="secondary" onClick={() => query.refetch()}>
              Try again
            </Button>
          </div>
        ) : null}

        {PRIVACY_SECTIONS.map((section) => (
          <ListGroup
            key={section.title}
            title={section.title}
            description={section.title === "Finding me" ? "People who share a chat with you can always find you by your name." : undefined}
          >
            {query.isPending && !user.privacy ? (
              <SkeletonList count={section.keys.length} />
            ) : (
              section.keys.map((key) => (
                <ListItem
                  key={key}
                  icon={ICONS[key]}
                  title={PRIVACY_META[key].title}
                  trailing={<span className="max-w-[160px] truncate">{rules ? ruleSummary(rules[key]) : AUDIENCE_LABEL[audiences[key]]}</span>}
                  href={`/app/settings/privacy/${key}`}
                />
              ))
            )}
          </ListGroup>
        ))}

        <ListGroup>
          <ListItem icon={UserX} title="Blocked users" subtitle="Blocked people can't find you at all" href="/app/settings/blocked" />
        </ListGroup>

        {/* Last and apart from everything else: a permanent action, not something to reach by accident. */}
        <div className="mt-8">
          <ListGroup title="Danger zone" description="Deleting your account is permanent. You'll be asked to confirm with your password.">
            <ListItem icon={Trash2} title="Delete account" danger onClick={() => setDeleteAccountOpen(true)} />
          </ListGroup>
        </div>
        {deleteAccountOpen ? <DeleteAccountDialog onClose={() => setDeleteAccountOpen(false)} /> : null}
      </PageBody>
    </div>
  );
}
