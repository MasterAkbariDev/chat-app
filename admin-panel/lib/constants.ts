/** httpOnly cookie that holds the admin JWT. Read on the server only; never visible to scripts. */
export const SESSION_COOKIE = "admin_session";

/** Matches the backend's ADMIN_TOKEN_TTL (12 h), so the cookie expires with the token. */
export const SESSION_MAX_AGE_SECONDS = 12 * 60 * 60;

/** Rows per page for every admin list. The backend clamps to 1–100. */
export const PAGE_SIZE = 50;
