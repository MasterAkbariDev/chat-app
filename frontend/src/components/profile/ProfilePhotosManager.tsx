"use client";

/* eslint-disable @next/next/no-img-element -- remote, backend-hosted profile photos */
import { useEffect, useId, useRef, useState } from "react";
import { Expand, ImagePlus, MoreHorizontal, Play, Star, Trash2 } from "lucide-react";
import { resolvePhotoSrc } from "@/components/ui/Avatar";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog, Dialog } from "@/components/ui/Dialog";
import { Menu, useMenuState } from "@/components/ui/Menu";
import { checkImageFile } from "@/components/ui/PhotoPicker";
import { Spinner } from "@/components/ui/Spinner";
import { useAuth } from "@/contexts/auth-context";
import { ApiError } from "@/lib/api/client";
import { uploadAvatarVideo, uploadImage } from "@/lib/api/media";
import { MediaEditor } from "@/components/media/editor/MediaEditor";
import type { PreparedMedia } from "@/components/media/editor/types";
import type { ProfilePhoto } from "@/lib/api/types";
import { cn } from "@/lib/cn";
import { ProfilePhotoViewer } from "./ProfilePhotoViewer";
import { photoStill, useMyPhotoActions, useUserPhotos } from "./use-profile-photos";

const MAX_VIDEO_BYTES = 50 * 1024 * 1024;

function errorText(err: unknown, fallback: string) {
  return err instanceof ApiError && err.message ? err.message : fallback;
}

/** Your profile photos and videos: add more, choose which one is your main
 *  photo (the one everybody sees next to your name), open or delete them.
 *  Changes save straight away. */
export function ProfilePhotosManager({ onClose }: { onClose: () => void }) {
  const { user } = useAuth();
  const { photos, query } = useUserPhotos(user);
  const { add, setMain, remove } = useMyPhotoActions();
  const inputRef = useRef<HTMLInputElement>(null);
  const statusId = useId();
  const [busy, setBusy] = useState<null | "image" | "video">(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [status, setStatus] = useState<{ text: string; tone: "info" | "error" } | null>(null);
  const [menuFor, setMenuFor] = useState<ProfilePhoto | null>(null);
  const menu = useMenuState();
  const [deleting, setDeleting] = useState<ProfilePhoto | null>(null);
  const [viewerAt, setViewerAt] = useState<number | null>(null);

  const name = user ? [user.firstName, user.lastName].filter(Boolean).join(" ") || user.username : "";
  const loaded = query.isSuccess;

  useEffect(() => {
    if (!preview) return;
    return () => URL.revokeObjectURL(preview);
  }, [preview]);

  // Picked → the editor (square crop; trim to 10 s for a video) → upload what it prepared.
  const [editing, setEditing] = useState<File | null>(null);
  function handleFile(file: File) {
    setStatus(null);
    const isVideo = file.type.startsWith("video/");
    if (isVideo ? file.size > MAX_VIDEO_BYTES : !!checkImageFile(file)) return void uploadPrepared({ kind: "file", file });
    setEditing(file);
  }

  async function uploadPrepared(prepared: PreparedMedia) {
    const file = prepared.file;
    setStatus(null);
    const isVideo = file.type.startsWith("video/");
    if (isVideo) {
      if (file.size > MAX_VIDEO_BYTES) {
        setStatus({ text: "That video is over 50 MB. Choose a shorter one.", tone: "error" });
        return;
      }
    } else {
      const problem = checkImageFile(file);
      if (problem) {
        setStatus({ text: problem, tone: "error" });
        return;
      }
      setPreview(URL.createObjectURL(file));
    }
    setBusy(isVideo ? "video" : "image");
    try {
      if (isVideo) {
        const v = await uploadAvatarVideo(file, prepared.kind === "video" ? prepared.edits : null);
        await add.mutateAsync({ url: v.url, posterUrl: v.posterUrl, kind: "video" });
        setStatus({ text: "Video added as your main photo. It plays silently, up to 10 seconds.", tone: "info" });
      } else {
        const img = await uploadImage(file);
        await add.mutateAsync({ url: img.url, kind: "image" });
        setStatus({ text: "Photo added as your main photo.", tone: "info" });
      }
    } catch (err) {
      setStatus({
        text: errorText(err, isVideo ? "Couldn't prepare that video. Try a different one." : "Couldn't upload the photo. Check your connection and try again."),
        tone: "error",
      });
    } finally {
      setBusy(null);
      setPreview(null);
    }
  }

  async function makeMain(photo: ProfilePhoto) {
    setStatus(null);
    try {
      await setMain.mutateAsync(photo.id);
      setStatus({ text: "Main photo updated. Everyone now sees it next to your name.", tone: "info" });
    } catch (err) {
      setStatus({ text: errorText(err, "Couldn't change your main photo. Try again."), tone: "error" });
    }
  }

  async function confirmDelete() {
    if (!deleting) return;
    try {
      await remove.mutateAsync(deleting.id);
      setStatus({ text: deleting.isMain ? "Photo deleted. Your next photo is now your main one." : "Photo deleted.", tone: "info" });
      setDeleting(null);
    } catch (err) {
      setDeleting(null);
      setStatus({ text: errorText(err, "Couldn't delete the photo. Try again."), tone: "error" });
    }
  }

  const tileBase = "relative aspect-square overflow-hidden rounded-[var(--radius-md)]";

  return (
    <>
      <Dialog
        onClose={onClose}
        title="Profile photos"
        description="Everyone can see these. Your main photo shows next to your name."
        size="md"
        footer={
          <Button variant="secondary" onClick={onClose}>
            Done
          </Button>
        }
      >
        <div className="flex flex-col gap-3">
          <ul className="grid grid-cols-3 gap-2" aria-label="Your photos" aria-describedby={statusId}>
            <li>
              <button
                type="button"
                onClick={() => inputRef.current?.click()}
                disabled={!!busy}
                className={cn(
                  tileBase,
                  "pressable flex w-full flex-col items-center justify-center gap-1.5 border-2 border-dashed border-line-strong bg-sunken px-2 text-center text-[13px] font-semibold leading-tight text-accent-text hover:border-accent disabled:opacity-60",
                )}
              >
                <ImagePlus className="size-6" strokeWidth={1.9} aria-hidden />
                Add photo or video
              </button>
            </li>

            {busy ? (
              <li className={cn(tileBase, "bg-sunken")} aria-hidden>
                {preview ? <img src={preview} alt="" className="size-full object-cover opacity-60" /> : null}
                <span className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/35 px-2 text-center text-[12.5px] font-semibold text-white">
                  <Spinner className="size-6 text-white" label={busy === "video" ? "Preparing your video" : "Uploading photo"} />
                  {busy === "video" ? "Preparing your video…" : "Uploading…"}
                </span>
              </li>
            ) : null}

            {photos.map((p, i) => {
              const src = resolvePhotoSrc(photoStill(p));
              const label = `${p.kind === "video" ? "Video" : "Photo"} ${i + 1}${p.isMain ? ", main photo" : ""}`;
              return (
                <li key={p.id} className={cn(tileBase, "bg-sunken")}>
                  <button
                    type="button"
                    aria-label={`${label}. Options`}
                    aria-haspopup="menu"
                    disabled={!loaded}
                    onClick={(e) => {
                      setMenuFor(p);
                      menu.openFrom(e.currentTarget);
                    }}
                    className="pressable group size-full"
                  >
                    {src ? <img src={src} alt="" loading="lazy" decoding="async" draggable={false} className="size-full object-cover" /> : null}
                    <span aria-hidden className="absolute inset-0 bg-black/0 transition-colors group-hover:bg-black/10" />
                    {p.isMain ? (
                      <span className="absolute start-1.5 top-1.5 inline-flex h-6 items-center gap-1 rounded-full bg-accent px-2 text-[12px] font-bold text-accent-fg shadow-md">
                        <Star className="size-3 fill-current" strokeWidth={2} aria-hidden />
                        Main
                      </span>
                    ) : null}
                    {p.kind === "video" ? (
                      <span aria-hidden className="absolute bottom-1.5 start-1.5 flex size-6 items-center justify-center rounded-full bg-black/55 text-white">
                        <Play className="size-3 fill-current" strokeWidth={0} />
                      </span>
                    ) : null}
                    <span aria-hidden className="absolute bottom-1.5 end-1.5 flex size-7 items-center justify-center rounded-full bg-black/45 text-white">
                      <MoreHorizontal className="size-4" strokeWidth={2.2} />
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>

          {query.isPending ? <p className="text-center text-[13.5px] text-muted">Loading your photos…</p> : null}
          {loaded && photos.length === 0 && !busy ? (
            <p className="text-center text-[13.5px] text-muted">No photos yet. Add one so people know it&apos;s you.</p>
          ) : null}

          <p
            id={statusId}
            aria-live="polite"
            className={cn("min-h-[1.25rem] text-center text-[13.5px] leading-snug", status?.tone === "error" ? "text-danger" : "text-fg-2")}
          >
            {status?.text}
          </p>
          <p className="text-center text-[12.5px] leading-snug text-muted">Photos up to 10 MB. Videos up to 50 MB; we keep the first 10 seconds, without sound.</p>
        </div>

        <input
          ref={inputRef}
          type="file"
          accept="image/*,video/*"
          className="sr-only"
          tabIndex={-1}
          aria-hidden
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (file) handleFile(file);
          }}
        />
      </Dialog>

      {editing ? (
        <MediaEditor
          files={[editing]}
          variant="single"
          lockSquare
          imageTier="standard"
          maxVideoSec={10}
          confirmLabel="Set photo"
          onClose={() => setEditing(null)}
          onDone={(r) => {
            setEditing(null);
            if (r.items[0]) void uploadPrepared(r.items[0]);
          }}
        />
      ) : null}

      {menu.anchor && menuFor ? (
        <Menu
          anchor={menu.anchor}
          aria-label="Photo options"
          onClose={menu.close}
          items={[
            ...(menuFor.isMain
              ? []
              : [{ key: "main", label: "Set as main photo", icon: Star, onSelect: () => void makeMain(menuFor), disabled: setMain.isPending }]),
            { key: "open", label: "Open", icon: Expand, onSelect: () => setViewerAt(Math.max(0, photos.findIndex((x) => x.id === menuFor.id))) },
            { key: "sep", separator: true as const },
            { key: "delete", label: "Delete", icon: Trash2, danger: true, onSelect: () => setDeleting(menuFor) },
          ]}
        />
      ) : null}

      {deleting ? (
        <ConfirmDialog
          title={deleting.kind === "video" ? "Delete this video?" : "Delete this photo?"}
          description={
            deleting.isMain
              ? "It's removed from your profile for everyone, and your next photo becomes your main one."
              : "It's removed from your profile for everyone."
          }
          confirmLabel={deleting.kind === "video" ? "Delete video" : "Delete photo"}
          destructive
          pending={remove.isPending}
          onConfirm={() => void confirmDelete()}
          onClose={() => setDeleting(null)}
        />
      ) : null}

      {viewerAt !== null ? (
        <ProfilePhotoViewer photos={photos} startIndex={viewerAt} name={name} onSetMain={(p) => setMain.mutateAsync(p.id)} onClose={() => setViewerAt(null)} />
      ) : null}
    </>
  );
}
