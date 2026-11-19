import { BadRequestException } from "@nestjs/common";

export const ADMIN_PAGE_DEFAULT = 50;
export const ADMIN_PAGE_MAX = 100;
export const ADMIN_TEXT_QUERY_MAX = 100;

/** Clamps `limit`/`offset` the same way the moderation list does, so every admin list behaves alike. */
export function pageOf(limit?: string, offset?: string) {
  return {
    limit: Math.min(
      Math.max(Number(limit) || ADMIN_PAGE_DEFAULT, 1),
      ADMIN_PAGE_MAX,
    ),
    offset: Math.max(Number(offset) || 0, 0),
  };
}

/** Escapes user input before it goes into a case-insensitive `RegExp`. */
export function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A trimmed search string, or `undefined` when empty. Rejects an overlong one with a 400. */
export function textQueryOf(q?: string): string | undefined {
  const trimmed = q?.trim();
  if (!trimmed) {
    return undefined;
  }
  if (trimmed.length > ADMIN_TEXT_QUERY_MAX) {
    throw new BadRequestException(
      `Search must be at most ${ADMIN_TEXT_QUERY_MAX} characters`,
    );
  }
  return trimmed;
}

/** An ISO date from a query string, or `undefined` when absent. A malformed date is a 400. */
export function dateQueryOf(value: string | undefined, name: string) {
  if (value === undefined || value === "") {
    return undefined;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new BadRequestException(`"${name}" must be a valid ISO date`);
  }
  return date;
}

/**
 * A search that is at least two characters. Shorter text would match almost every row, so it is
 * a 400 rather than a silent full scan.
 */
export function searchTextOf(q?: string): string | undefined {
  const trimmed = textQueryOf(q);
  if (trimmed !== undefined && trimmed.length < 2) {
    throw new BadRequestException("Search needs at least 2 characters");
  }
  return trimmed;
}
