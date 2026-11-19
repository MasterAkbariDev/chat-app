"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/contexts/auth-context";
import { ApiError } from "@/lib/api/client";
import { PRIVACY_QUERY_KEY, audiencesOf, getPrivacyRules, updatePrivacy } from "@/lib/api/users";
import type { PrivacyAudience, PrivacyKey, PrivacyRulesView, PublicUser } from "@/lib/api/types";

export interface RuleChange {
  key: PrivacyKey;
  audience?: PrivacyAudience;
  /** Full replacement lists (people, so the optimistic view can render them). */
  allow?: PublicUser[];
  deny?: PublicUser[];
}

/** Applies a change to the cached view the way the server will: a list
 * replaces the stored one, and anyone put on one list leaves the other. */
export function applyChange(view: PrivacyRulesView, change: RuleChange): PrivacyRulesView {
  const current = view[change.key];
  let allow = change.allow ?? current.allow;
  let deny = change.deny ?? current.deny;
  if (change.allow && !change.deny) deny = deny.filter((d) => !allow.some((a) => a._id === d._id));
  if (change.deny && !change.allow) allow = allow.filter((a) => !deny.some((d) => d._id === a._id));
  return { ...view, [change.key]: { audience: change.audience ?? current.audience, allow, deny } };
}

/** Privacy settings with exceptions — saved the moment they change (shown
 * straight away, put back if the save fails). Keeps `me.privacy` in step. */
export function usePrivacyRules() {
  const queryClient = useQueryClient();
  const { updateUser } = useAuth();
  const [error, setError] = useState<string | null>(null);
  const query = useQuery({ queryKey: PRIVACY_QUERY_KEY, queryFn: getPrivacyRules });

  const mutation = useMutation({
    mutationFn: (change: RuleChange) =>
      updatePrivacy({
        [change.key]: {
          ...(change.audience ? { audience: change.audience } : {}),
          ...(change.allow ? { allow: change.allow.map((u) => u._id) } : {}),
          ...(change.deny ? { deny: change.deny.map((u) => u._id) } : {}),
        },
      }),
    onMutate: async (change) => {
      setError(null);
      await queryClient.cancelQueries({ queryKey: PRIVACY_QUERY_KEY });
      const previous = queryClient.getQueryData<PrivacyRulesView>(PRIVACY_QUERY_KEY);
      if (previous) {
        const next = applyChange(previous, change);
        queryClient.setQueryData(PRIVACY_QUERY_KEY, next);
        updateUser({ privacy: audiencesOf(next) });
      }
      return { previous };
    },
    onSuccess: (saved) => {
      queryClient.setQueryData(PRIVACY_QUERY_KEY, saved);
      updateUser({ privacy: audiencesOf(saved) });
    },
    onError: (err, _change, ctx) => {
      if (ctx?.previous) {
        queryClient.setQueryData(PRIVACY_QUERY_KEY, ctx.previous);
        updateUser({ privacy: audiencesOf(ctx.previous) });
      }
      setError(
        err instanceof ApiError && err.status === 429
          ? "Too many changes in a row. Wait a moment, then try again."
          : err instanceof ApiError && err.status === 400
            ? err.message
            : "Couldn't save that. Check your connection and try again.",
      );
    },
  });

  return { query, rules: query.data, change: mutation.mutate, error, saving: mutation.isPending };
}
