"use client";

import { useState } from "react";
import { File as FileIcon, Music2, X } from "lucide-react";
import { Dialog } from "@/components/ui/Dialog";
import { Button } from "@/components/ui/Button";
import { categoryColors, fileCategory, formatBytes, looksLikeAudio } from "@/lib/files";

interface FileSendDialogProps {
  files: File[];
  mode: "file" | "music";
  onClose: () => void;
  onSend: (files: File[], mode: "file" | "music", caption: string) => void;
  /** Starts with the caption typed in the composer when the files were picked. */
  initialCaption?: string;
}

/** Telegram's "Send N files" sheet: the picked files (remove any), a caption, Send. Files go
 *  out together as one message (music as one music group). */
export function FileSendDialog({ files: initial, mode, onClose, onSend, initialCaption = "" }: FileSendDialogProps) {
  const [files, setFiles] = useState(initial);
  const [caption, setCaption] = useState(initialCaption);
  const music = files.length > 0 && files.every((f) => mode === "music" || looksLikeAudio(f));
  const noun = music ? (files.length === 1 ? "track" : "tracks") : files.length === 1 ? "file" : "files";

  function send() {
    if (!files.length) return;
    onSend(files, mode, caption.trim());
    onClose();
  }

  return (
    <Dialog
      onClose={onClose}
      title={`Send ${files.length} ${noun}`}
      size="sm"
      onSubmit={(e) => {
        e.preventDefault();
        send();
      }}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={!files.length}>
            Send
          </Button>
        </>
      }
    >
      <ul className="flex max-h-[40vh] flex-col gap-1 overflow-y-auto" aria-label="Files to send">
        {files.map((f, i) => {
          const audio = mode === "music" || looksLikeAudio(f);
          const colors = categoryColors(fileCategory(f.name, f.type));
          return (
            <li key={`${f.name}-${i}`} className="flex items-center gap-3 rounded-[var(--radius-sm)] py-1.5 pe-1 ps-1">
              <span className="flex size-10 shrink-0 items-center justify-center rounded-full" style={audio ? undefined : { background: colors.bg, color: colors.fg }}>
                {audio ? (
                  <span className="flex size-10 items-center justify-center rounded-full bg-accent text-accent-fg">
                    <Music2 className="size-5" strokeWidth={2} aria-hidden />
                  </span>
                ) : (
                  <FileIcon className="size-5" strokeWidth={1.9} aria-hidden />
                )}
              </span>
              <span className="min-w-0 flex-1">
                <span dir="auto" className="block truncate text-start text-[14.5px] font-semibold">
                  {f.name}
                </span>
                <span className="tabular block text-[12.5px] text-muted">{formatBytes(f.size)}</span>
              </span>
              <button
                type="button"
                onClick={() => setFiles((list) => list.filter((_, k) => k !== i))}
                aria-label={`Remove ${f.name}`}
                title="Remove"
                className="pressable flex size-10 shrink-0 items-center justify-center rounded-full text-muted hover:bg-sunken hover:text-fg"
              >
                <X className="size-[18px]" strokeWidth={2} />
              </button>
            </li>
          );
        })}
      </ul>
      <textarea
        dir="auto"
        rows={2}
        value={caption}
        maxLength={4000}
        onChange={(e) => setCaption(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && !window.matchMedia?.("(pointer: coarse)").matches) {
            e.preventDefault();
            send();
          }
        }}
        placeholder="Add a caption"
        aria-label="Caption"
        className="mt-3 max-h-40 min-h-11 w-full resize-y rounded-[var(--radius-sm)] border border-line bg-sunken px-3 py-2.5 text-start text-[15px] outline-none placeholder:text-muted focus:border-accent focus:bg-raised"
      />
    </Dialog>
  );
}
