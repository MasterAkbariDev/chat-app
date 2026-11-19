"use client";

import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { CheckCircle2 } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { Field, Input, Textarea } from "@/components/ui/Field";
import { createReport, type ReportTargetType } from "@/lib/api/reports";
import { ApiError } from "@/lib/api/client";

export interface ReportDialogProps {
  targetType: ReportTargetType;
  targetId: string;
  /** Shown in the dialog title as "Report {targetLabel}" — e.g. "this message", a username, a chat name. */
  targetLabel: string;
  onClose: () => void;
}

// One generic dialog for all three reportable target types (message/user/
// channel) — the backend is a single `POST /v1/reports` with a `targetType`
// discriminator, so there's no reason for three near-identical components.
export function ReportDialog({ targetType, targetId, targetLabel, onClose }: ReportDialogProps) {
  const [reason, setReason] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: () => createReport({ targetType, targetId, reason: reason.trim(), note: note.trim() || undefined }),
    onError: (err) => setError(err instanceof ApiError ? err.message : "The report didn't send. Check your connection and try again."),
  });

  function submit() {
    if (!reason.trim()) {
      setError("Add a short reason so a moderator knows what to look for.");
      return;
    }
    setError(null);
    mutation.mutate();
  }

  if (mutation.isSuccess) {
    return (
      <Dialog
        onClose={onClose}
        aria-label="Report sent"
        hideClose
        footer={
          <Button onClick={onClose} data-autofocus>
            Done
          </Button>
        }
      >
        <div className="flex flex-col items-center gap-2 pb-2 pt-4 text-center">
          <div className="mb-1 flex size-14 items-center justify-center rounded-full bg-success-soft text-success">
            <CheckCircle2 className="size-7" strokeWidth={1.8} aria-hidden />
          </div>
          <h2 className="text-[18px] font-bold text-fg">Report sent</h2>
          <p className="max-w-[300px] text-[14px] leading-relaxed text-muted">A moderator will review it. Thanks for flagging this.</p>
        </div>
      </Dialog>
    );
  }

  return (
    <Dialog
      onClose={onClose}
      title={`Report ${targetLabel}`}
      description="This goes to a moderator, not the person you're reporting."
      onSubmit={submit}
      bodyClassName="flex flex-col gap-4 pb-4"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={mutation.isPending}>
            Send report
          </Button>
        </>
      }
    >
      <Field label="Reason" error={error ?? undefined} hint="A few words is enough — e.g. spam, harassment, scam.">
        <Input
          value={reason}
          onChange={(e) => {
            setReason(e.target.value);
            if (error) setError(null);
          }}
          placeholder="What's wrong?"
          maxLength={100}
          autoComplete="off"
          data-autofocus
          required
        />
      </Field>

      <Field label="More details (optional)" hint={`${note.length}/1000`}>
        <Textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Anything else a moderator should know"
          maxLength={1000}
        />
      </Field>
    </Dialog>
  );
}
