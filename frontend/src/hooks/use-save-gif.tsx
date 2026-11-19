"use client";

import { useContext, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { QueryClient, QueryClientContext, useMutation, useQuery } from "@tanstack/react-query";
import { Check } from "lucide-react";
import { ApiError } from "@/lib/api/client";
import { getSavedGifs, saveGifFromMessage, SAVED_GIFS_KEY, type SavedGif } from "@/lib/api/gifs";

interface GifMessageLike {
  id: string;
  type: string;
  attachments?: string[];
  attachmentMeta?: Record<string, { mediaId: string }> | null;
  sendStatus?: "pending" | "failed";
}

/** Used only when there's no QueryClientProvider above (e.g. a bubble
 *  rendered on its own in a test): everything stays disabled. */
let inertClient: QueryClient | null = null;

/** message id → the library's mediaId it was saved as, for messages whose own
 *  media can't be matched against the library (migrated `/uploads/<file>.gif`
 *  links get ingested as a new asset when saved). */
const savedAs = new Map<string, string>();

/** "Save GIF" for a GIF message: whether it's already in your library, the
 *  save action, and a transient "Saved to your GIFs" toast to render. */
export function useSaveGif(message: GifMessageLike) {
  const url = message.attachments?.[0];
  const contextClient = useContext(QueryClientContext);
  const queryClient = contextClient ?? (inertClient ??= new QueryClient());
  const canSave = !!contextClient && !message.sendStatus && !!url && (message.type === "gif" || (message.type === "image" && /\.gif($|\?)/i.test(url)));
  const savedQuery = useQuery({ queryKey: SAVED_GIFS_KEY, queryFn: () => getSavedGifs(), enabled: canSave, staleTime: 60_000 }, queryClient);
  const [toast, setToast] = useState<{ text: string; error?: boolean } | null>(null);

  const mediaId = url ? message.attachmentMeta?.[url]?.mediaId : undefined;
  const saved =
    canSave &&
    !!savedQuery.data?.some(
      (g) => (mediaId && g.mediaId === mediaId) || g.mediaId === savedAs.get(message.id) || (!!url && url.endsWith(`/uploads/media/${g.relativePath}`)),
    );

  const mutation = useMutation({
    mutationFn: () => saveGifFromMessage(message.id),
    onSuccess: (gif) => {
      savedAs.set(message.id, gif.mediaId);
      queryClient.setQueryData<SavedGif[]>(SAVED_GIFS_KEY, (prev) => [gif, ...(prev ?? []).filter((g) => g.id !== gif.id)]);
      setToast({ text: "Saved to your GIFs" });
    },
    onError: (err) => setToast({ text: err instanceof ApiError && err.status < 500 ? err.message : "Couldn't save that GIF. Try again.", error: true }),
  }, queryClient);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 2200);
    return () => clearTimeout(t);
  }, [toast]);

  const toastNode =
    toast && typeof document !== "undefined"
      ? createPortal(
          <div className="pointer-events-none fixed inset-x-0 bottom-[calc(96px+env(safe-area-inset-bottom))] z-[120] flex justify-center px-4">
            <div
              role={toast.error ? "alert" : "status"}
              className={
                "pop-in flex items-center gap-2 rounded-full px-4 py-2.5 text-[14px] font-semibold shadow-lg " +
                (toast.error ? "bg-danger text-white" : "bg-fg text-canvas")
              }
            >
              {toast.error ? null : <Check className="size-4" strokeWidth={2.4} aria-hidden />}
              {toast.text}
            </div>
          </div>,
          document.body,
        )
      : null;

  return {
    canSave,
    saved,
    saving: mutation.isPending,
    save: () => {
      if (!saved && !mutation.isPending) mutation.mutate();
    },
    toast: toastNode,
  };
}
