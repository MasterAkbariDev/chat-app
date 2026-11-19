"use client";

import { useCallback } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/contexts/auth-context";
import { getProfile } from "@/lib/api/auth";
import { CHANNELS_QUERY_KEY } from "@/lib/api/chats";
import { addProfilePhoto, deleteProfilePhoto, getUserPhotos, setMainProfilePhoto, userPhotosKey } from "@/lib/api/user";
import type { ProfilePhoto, PublicUser } from "@/lib/api/types";

/** What we can show before the photo list loads: the main photo from the
 *  user record itself (a video's poster plus the video, when it's a video). */
export function photosFromUser(user: Pick<PublicUser, "_id" | "avatarUrl" | "avatarVideoUrl"> | null | undefined): ProfilePhoto[] {
  const still = user?.avatarUrl?.[0];
  if (!user || !still) return [];
  const video = user.avatarVideoUrl;
  return [
    {
      id: `main-${user._id}`,
      url: video ?? still,
      kind: video ? "video" : "image",
      posterUrl: video ? still : null,
      createdAt: "",
      isMain: true,
    },
  ];
}

/** Every photo someone has (main first). Falls back to the main photo from
 *  their user record while loading, so the hero never flashes empty. */
export function useUserPhotos(user: Pick<PublicUser, "_id" | "avatarUrl" | "avatarVideoUrl"> | null | undefined) {
  const userId = user?._id;
  const query = useQuery({
    queryKey: userPhotosKey(userId ?? ""),
    queryFn: () => getUserPhotos(userId!),
    enabled: !!userId,
    staleTime: 30_000,
  });
  return { photos: query.data ?? photosFromUser(user), query };
}

/** The still to show for a photo: the image itself, or a video's poster. */
export function photoStill(photo: ProfilePhoto): string | null {
  return photo.kind === "video" ? photo.posterUrl : photo.url;
}

/** Add / set main / delete for your own photos, keeping everything that shows
 *  your main photo in step: your cached profile (`me`), your photo list, your
 *  public profile and the chat list (where it's your avatar for others). */
export function useMyPhotoActions() {
  const { user, updateUser } = useAuth();
  const queryClient = useQueryClient();
  const myId = user?._id ?? "";

  const sync = useCallback(
    async (list: ProfilePhoto[]) => {
      queryClient.setQueryData(userPhotosKey(myId), list);
      // `avatarUrl[0]` / `avatarVideoUrl` are computed server-side, so read them back.
      try {
        const me = await getProfile();
        updateUser({ avatarUrl: me.avatarUrl, avatarVideoUrl: me.avatarVideoUrl ?? null });
      } catch {
        // Offline for a moment: the list is right; `me` catches up on the next refresh.
      }
      void queryClient.invalidateQueries({ queryKey: userPhotosKey(myId) });
      void queryClient.invalidateQueries({ queryKey: ["users", "profile", myId] });
      void queryClient.invalidateQueries({ queryKey: CHANNELS_QUERY_KEY });
    },
    [queryClient, myId, updateUser],
  );

  const add = useMutation({
    mutationFn: addProfilePhoto,
    onSuccess: sync,
  });
  const setMain = useMutation({
    mutationFn: (photoId: string) => setMainProfilePhoto(photoId),
    onSuccess: sync,
  });
  const remove = useMutation({
    mutationFn: (photoId: string) => deleteProfilePhoto(photoId),
    onSuccess: sync,
  });

  return { add, setMain, remove };
}
