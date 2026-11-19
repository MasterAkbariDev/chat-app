"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Camera } from "lucide-react";
import { Avatar } from "@/components/ui/Avatar";
import { Button } from "@/components/ui/Button";
import { Spinner } from "@/components/ui/Spinner";
import { uploadImage } from "@/lib/api/media";
import { MediaEditor } from "@/components/media/editor/MediaEditor";
import { ApiError } from "@/lib/api/client";
import { cn } from "@/lib/cn";

const MAX_BYTES = 10 * 1024 * 1024;

/** The photo rules every picker shares: an image, at most 10 MB. Returns what to
 *  tell the person, or null when the file is fine. */
export function checkImageFile(file: File): string | null {
  if (!file.type.startsWith("image/")) return "That file isn't an image. Choose a JPG, PNG, WebP or GIF.";
  if (file.size > MAX_BYTES) return "That photo is over 10 MB. Choose a smaller one.";
  return null;
}

export interface PhotoPickerProps {
  /** Current photo URL, or null for none (initials are shown instead). */
  value: string | null;
  /** Called with the uploaded image's URL, or null when the photo is removed. */
  onChange: (url: string | null) => void;
  /** Used for the initials fallback. */
  name?: string;
  /** Stable id for the person colour behind the initials. */
  colorId?: string;
  /** Circle for people, rounded square for groups and channels. */
  shape?: "circle" | "square";
  size?: number;
  disabled?: boolean;
  /** Lets the parent hold its Save button while an upload is in flight. */
  onUploadingChange?: (uploading: boolean) => void;
  className?: string;
}

/** Shows a photo with a camera badge; tapping it opens the file picker,
 *  uploads the image (`POST /upload/image`) and hands back its URL. */
export function PhotoPicker({
  value,
  onChange,
  name,
  colorId,
  shape = "circle",
  size = 96,
  disabled,
  onUploadingChange,
  className,
}: PhotoPickerProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const statusId = useId();

  // Free the local preview's object URL when it's replaced or on unmount.
  useEffect(() => {
    if (!preview) return;
    return () => URL.revokeObjectURL(preview);
  }, [preview]);

  function setBusy(next: boolean) {
    setUploading(next);
    onUploadingChange?.(next);
  }

  // Picked → square crop / adjust in the media editor → upload the result.
  const [editing, setEditing] = useState<File | null>(null);
  function pick(file: File) {
    setError(null);
    const problem = checkImageFile(file);
    if (problem) {
      setError(problem);
      return;
    }
    // Animated GIFs can't be edited (it would flatten them): upload as they are.
    if (file.type === "image/gif") void handleFile(file);
    else setEditing(file);
  }

  async function handleFile(file: File) {
    setError(null);
    setPreview(URL.createObjectURL(file));
    setBusy(true);
    try {
      const uploaded = await uploadImage(file);
      onChange(uploaded.url);
    } catch (err) {
      setError(err instanceof ApiError && err.message ? err.message : "Couldn't upload the photo. Check your connection and try again.");
    } finally {
      setPreview(null);
      setBusy(false);
    }
  }

  const hasPhoto = !!value;
  const label = hasPhoto ? "Change photo" : "Add photo";
  const badge = Math.max(32, Math.round(size * 0.36));

  return (
    <div className={cn("flex flex-col items-center gap-2", className)}>
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        disabled={disabled || uploading}
        aria-label={label}
        aria-describedby={statusId}
        title={label}
        className={cn("pressable relative shrink-0 disabled:cursor-default", shape === "circle" ? "rounded-full" : "rounded-[30%]")}
        style={{ width: size, height: size }}
      >
        <Avatar colorId={colorId} name={name} src={preview ?? value} size={size} shape={shape} />
        {uploading ? (
          <span
            aria-hidden
            className={cn("absolute inset-0 flex items-center justify-center bg-black/45 text-white", shape === "circle" ? "rounded-full" : "rounded-[30%]")}
          >
            <Spinner className="size-7 text-white" label="Uploading photo" />
          </span>
        ) : null}
        <span
          aria-hidden
          className="absolute flex items-center justify-center rounded-full bg-accent text-accent-fg shadow-md"
          style={{ width: badge, height: badge, insetInlineEnd: shape === "circle" ? -2 : -6, bottom: shape === "circle" ? -2 : -6, boxShadow: "0 0 0 3px var(--raised)" }}
        >
          <Camera style={{ width: badge * 0.5, height: badge * 0.5 }} strokeWidth={2.1} />
        </span>
      </button>

      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        className="sr-only"
        tabIndex={-1}
        aria-hidden
        onChange={(e) => {
          const file = e.target.files?.[0];
          // Reset so picking the same file again still fires a change.
          e.target.value = "";
          if (file) pick(file);
        }}
      />

      <div id={statusId} aria-live="polite" className="text-center text-[12.5px] leading-snug">
        {uploading ? (
          <span className="text-muted">Uploading photo…</span>
        ) : error ? (
          <span role="alert" className="text-danger">
            {error}
          </span>
        ) : null}
      </div>

      {editing ? (
        <MediaEditor
          files={[editing]}
          variant="single"
          lockSquare
          allowVideo={false}
          imageTier="standard"
          confirmLabel="Set photo"
          onClose={() => setEditing(null)}
          onDone={(r) => {
            setEditing(null);
            if (r.items[0]) void handleFile(r.items[0].file);
          }}
        />
      ) : null}

      {hasPhoto && !uploading ? (
        <Button variant="ghost" size="sm" className="h-11 text-danger hover:text-danger" disabled={disabled} onClick={() => { setError(null); onChange(null); }}>
          Remove photo
        </Button>
      ) : null}
    </div>
  );
}
