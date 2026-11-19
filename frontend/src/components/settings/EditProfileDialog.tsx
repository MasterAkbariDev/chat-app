"use client";

import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Camera, Images } from "lucide-react";
import { Avatar } from "@/components/ui/Avatar";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { Field, Input, Textarea } from "@/components/ui/Field";
import { updateProfile } from "@/lib/api/user";
import { ApiError } from "@/lib/api/client";
import { useAuth } from "@/contexts/auth-context";
import { ProfilePhotosManager } from "@/components/profile/ProfilePhotosManager";
import { useUserPhotos } from "@/components/profile/use-profile-photos";

export interface EditProfileDialogProps {
  onClose: () => void;
}

const BIO_MAX = 500;

/** Edits name, username and bio (saved with "Save changes"). Photos live in the
 *  "Profile photos" manager it opens, where changes save straight away. */
export function EditProfileDialog({ onClose }: EditProfileDialogProps) {
  const { user, updateUser } = useAuth();
  const [firstName, setFirstName] = useState(user?.firstName ?? "");
  const [lastName, setLastName] = useState(user?.lastName ?? "");
  const [username, setUsername] = useState(user?.username ?? "");
  const [bio, setBio] = useState(user?.bio ?? "");
  const [photosOpen, setPhotosOpen] = useState(false);
  const { photos } = useUserPhotos(user);
  const [error, setError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: () =>
      updateProfile({
        firstName: firstName.trim(),
        lastName: lastName.trim(),
        username: username.trim(),
        bio,
      }),
    onSuccess: (me) => {
      updateUser(me);
      onClose();
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : "Couldn't save your profile. Check your connection and try again."),
  });

  const canSubmit = username.trim().length > 0;
  const previewName = [firstName.trim(), lastName.trim()].filter(Boolean).join(" ") || username.trim() || "?";

  function submit() {
    if (!canSubmit) return;
    setError(null);
    mutation.mutate();
  }

  return (
    <>
      <Dialog
        onClose={onClose}
        onSubmit={submit}
        title="Edit profile"
        description="Visible to people you chat with."
        footer={
          <>
            <Button variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" loading={mutation.isPending} disabled={!canSubmit}>
              Save changes
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          <div className="flex items-center gap-4 rounded-[var(--radius-md)] bg-sunken p-3">
            <button
              type="button"
              onClick={() => setPhotosOpen(true)}
              aria-label="Profile photos"
              title="Profile photos"
              className="pressable relative shrink-0 rounded-full"
            >
              <Avatar colorId={user?._id} name={previewName} src={user?.avatarUrl?.[0]} size={72} />
              <span
                aria-hidden
                className="absolute -bottom-0.5 -end-0.5 flex size-7 items-center justify-center rounded-full bg-accent text-accent-fg"
                style={{ boxShadow: "0 0 0 3px var(--sunken)" }}
              >
                <Camera className="size-3.5" strokeWidth={2.1} />
              </span>
            </button>
            <div className="min-w-0 flex-1">
              <div dir="auto" className="truncate text-[15px] font-semibold text-fg">{previewName}</div>
              <div className="truncate text-[13px] text-muted">@{username.trim() || "username"}</div>
              <Button variant="ghost" size="sm" className="-ms-2 mt-1 h-10 text-accent-text" onClick={() => setPhotosOpen(true)}>
                <Images className="size-4" strokeWidth={1.9} aria-hidden />
                {photos.length > 1 ? `Profile photos (${photos.length})` : photos.length === 1 ? "Profile photos" : "Add a photo"}
              </Button>
            </div>
          </div>

          <div className="grid grid-cols-1 gap-4 min-[400px]:grid-cols-2">
            <Field label="First name">
              <Input value={firstName} onChange={(e) => setFirstName(e.target.value)} autoComplete="given-name" autoFocus />
            </Field>
            <Field label="Last name">
              <Input value={lastName} onChange={(e) => setLastName(e.target.value)} autoComplete="family-name" />
            </Field>
          </div>

          <Field label="Username" hint="People can find you by your username." error={error ?? undefined}>
            <Input
              value={username}
              onChange={(e) => {
                setUsername(e.target.value);
                if (error) setError(null);
              }}
              invalid={!!error}
              autoComplete="username"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              required
            />
          </Field>

          <Field
            label="Bio"
            labelAside={
              <span className="tabular text-[12.5px] text-muted" aria-live="polite">
                {bio.length}/{BIO_MAX}
              </span>
            }
          >
            <Textarea value={bio} onChange={(e) => setBio(e.target.value.slice(0, BIO_MAX))} rows={3} placeholder="Say something about yourself" />
          </Field>
        </div>
      </Dialog>
      {photosOpen ? <ProfilePhotosManager onClose={() => setPhotosOpen(false)} /> : null}
    </>
  );
}
