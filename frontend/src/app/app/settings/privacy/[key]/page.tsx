"use client";

import { useState } from "react";
import { useParams } from "next/navigation";
import { ShieldQuestion, UserPlus, X } from "lucide-react";
import { Avatar } from "@/components/ui/Avatar";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { ListGroup, ListItem } from "@/components/ui/List";
import { PageBody, PageHeader } from "@/components/ui/PageHeader";
import { SkeletonList } from "@/components/ui/Skeleton";
import { AudiencePicker } from "@/components/settings/privacy/AudiencePicker";
import { AddPeopleDialog } from "@/components/settings/privacy/AddPeopleDialog";
import { PRIVACY_META, isPrivacyKey, showsAllow, showsDeny } from "@/components/settings/privacy/privacy-meta";
import { usePrivacyRules } from "@/components/settings/privacy/use-privacy";
import type { PrivacyKey, PublicUser } from "@/lib/api/types";

function nameOf(u: PublicUser) {
  return [u.firstName, u.lastName].filter(Boolean).join(" ") || u.username;
}

/** One privacy setting: who (radio list, live explanation) plus Telegram's
 * "Always allow" / "Never allow" exceptions. Every change saves at once. */
export default function PrivacySettingPage() {
  const { key } = useParams<{ key: string }>();
  if (!isPrivacyKey(key)) {
    return (
      <div className="flex min-h-0 flex-1 flex-col bg-canvas">
        <PageHeader title="Privacy" backHref="/app/settings/privacy" backLabel="Back to privacy" backOnDesktop />
        <PageBody>
          <EmptyState icon={ShieldQuestion} title="No such setting" description="This privacy setting doesn't exist." />
        </PageBody>
      </div>
    );
  }
  return <PrivacySetting settingKey={key} />;
}

function PrivacySetting({ settingKey }: { settingKey: PrivacyKey }) {
  const meta = PRIVACY_META[settingKey];
  const { query, rules, change, error } = usePrivacyRules();
  const [adding, setAdding] = useState<"allow" | "deny" | null>(null);
  const rule = rules?.[settingKey];

  const allowTitle = "Always allow";
  const denyTitle = "Never allow";

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-canvas">
      <PageHeader title={meta.title} backHref="/app/settings/privacy" backLabel="Back to privacy and security" backOnDesktop />

      <PageBody>
        {error ? (
          <p role="alert" className="rounded-[var(--radius-sm)] bg-danger-soft px-3 py-2 text-[13.5px] text-danger">
            {error}
          </p>
        ) : null}

        {!rule ? (
          query.isError ? (
            <div className="flex flex-col items-center gap-3 py-10 text-center">
              <p className="text-[14px] text-danger">Couldn&apos;t load this setting.</p>
              <Button size="sm" variant="secondary" onClick={() => query.refetch()}>
                Try again
              </Button>
            </div>
          ) : (
            <div className="overflow-hidden rounded-[var(--radius-md)] border border-line bg-panel py-1">
              <SkeletonList count={3} />
            </div>
          )
        ) : (
          <>
            <AudiencePicker
              title={meta.question}
              value={rule.audience}
              description={
                <>
                  {meta.explain[rule.audience]}
                  {meta.footnote ? <> {meta.footnote}</> : null}
                </>
              }
              onChange={(audience) => {
                if (audience !== rule.audience) change({ key: settingKey, audience });
              }}
            />

            {showsAllow(rule.audience) ? (
              <ExceptionList
                title={allowTitle}
                description={
                  meta.verb === "see"
                    ? `These people will always see your ${meta.title.toLowerCase()}, whatever you pick above.`
                    : "These people always can, whatever you pick above."
                }
                people={rule.allow}
                onAdd={() => setAdding("allow")}
                onRemove={(u) => change({ key: settingKey, allow: rule.allow.filter((p) => p._id !== u._id) })}
              />
            ) : null}
            {showsDeny(rule.audience) ? (
              <ExceptionList
                title={denyTitle}
                description={
                  meta.verb === "see"
                    ? `These people will never see your ${meta.title.toLowerCase()}, whatever you pick above.`
                    : "These people never can, whatever you pick above."
                }
                people={rule.deny}
                onAdd={() => setAdding("deny")}
                onRemove={(u) => change({ key: settingKey, deny: rule.deny.filter((p) => p._id !== u._id) })}
              />
            ) : null}
          </>
        )}
      </PageBody>

      {adding && rule ? (
        <AddPeopleDialog
          title={adding === "allow" ? allowTitle : denyTitle}
          exclude={(adding === "allow" ? rule.allow : rule.deny).map((u) => u._id)}
          onClose={() => setAdding(null)}
          onAdd={(people) =>
            change(
              adding === "allow"
                ? { key: settingKey, allow: [...rule.allow, ...people] }
                : { key: settingKey, deny: [...rule.deny, ...people] },
            )
          }
        />
      ) : null}
    </div>
  );
}

function ExceptionList({
  title,
  description,
  people,
  onAdd,
  onRemove,
}: {
  title: string;
  description: string;
  people: PublicUser[];
  onAdd: () => void;
  onRemove: (u: PublicUser) => void;
}) {
  return (
    <ListGroup title={title} description={description}>
      <ListItem icon={UserPlus} title={<span className="text-accent-text">Add users</span>} onClick={onAdd} />
      {people.map((u) => {
        const name = nameOf(u);
        return (
          <ListItem
            key={u._id}
            leading={<Avatar colorId={u._id} name={name} src={u.avatarUrl?.[0]} size={36} />}
            title={name}
            subtitle={`@${u.username}`}
            trailing={
              <button
                type="button"
                onClick={() => onRemove(u)}
                aria-label={`Remove ${name}`}
                className="pressable flex size-11 items-center justify-center rounded-full text-muted hover:bg-sunken hover:text-danger"
              >
                <X className="size-[18px]" strokeWidth={2} aria-hidden />
              </button>
            }
          />
        );
      })}
    </ListGroup>
  );
}
