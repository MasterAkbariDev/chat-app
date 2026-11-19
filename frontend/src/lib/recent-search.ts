/** Recent searches for the global search box (Telegram-style): the queries
 * you ran and the results you opened. Kept per device in localStorage
 * (`chat:recent-search`). Every storage access is wrapped — private
 * windows and blocked site data just give you an empty list. */

const STORAGE_KEY = "chat:recent-search";
const MAX_QUERIES = 5;
const MAX_RESULTS = 8;

/** What opening a recent result does again. */
export type RecentTarget =
  | { type: "chat"; channelId: string }
  /** A person you don't necessarily have a chat with yet — opening finds or
   * creates the DM. */
  | { type: "person"; userId: string };

export interface RecentResult {
  /** Stable identity, so opening the same thing twice moves it to the top. */
  key: string;
  title: string;
  subtitle?: string;
  /** Picks the avatar colour. */
  colorId: string;
  shape: "circle" | "square";
  image?: string | null;
  target: RecentTarget;
  at: number;
}

export interface RecentSearchState {
  queries: string[];
  results: RecentResult[];
}

const EMPTY: RecentSearchState = { queries: [], results: [] };

let cache: RecentSearchState | null = null;
const listeners = new Set<() => void>();

function isResult(value: unknown): value is RecentResult {
  if (!value || typeof value !== "object") return false;
  const r = value as Partial<RecentResult>;
  return (
    typeof r.key === "string" &&
    typeof r.title === "string" &&
    typeof r.colorId === "string" &&
    (r.shape === "circle" || r.shape === "square") &&
    !!r.target &&
    ((r.target.type === "chat" && typeof r.target.channelId === "string") ||
      (r.target.type === "person" && typeof r.target.userId === "string"))
  );
}

function load(): RecentSearchState {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return EMPTY;
    const parsed = JSON.parse(raw) as Partial<RecentSearchState>;
    return {
      queries: Array.isArray(parsed.queries) ? parsed.queries.filter((q): q is string => typeof q === "string").slice(0, MAX_QUERIES) : [],
      results: Array.isArray(parsed.results) ? parsed.results.filter(isResult).slice(0, MAX_RESULTS) : [],
    };
  } catch {
    return EMPTY;
  }
}

function save(next: RecentSearchState) {
  cache = next;
  try {
    if (next.queries.length === 0 && next.results.length === 0) window.localStorage.removeItem(STORAGE_KEY);
    else window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Storage full or blocked — keep the in-memory copy for this session.
  }
  listeners.forEach((l) => l());
}

/** For useSyncExternalStore. Returns the same object until something changes. */
export function getRecentSearch(): RecentSearchState {
  if (typeof window === "undefined") return EMPTY;
  if (!cache) cache = load();
  return cache;
}

export function getRecentSearchServerSnapshot(): RecentSearchState {
  return EMPTY;
}

export function subscribeRecentSearch(listener: () => void): () => void {
  listeners.add(listener);
  // Another tab changed it.
  const onStorage = (e: StorageEvent) => {
    if (e.key !== STORAGE_KEY) return;
    cache = load();
    listener();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

export function addRecentQuery(query: string) {
  const q = query.trim();
  if (q.length < 2) return;
  const prev = getRecentSearch();
  const lower = q.toLocaleLowerCase();
  const queries = [q, ...prev.queries.filter((x) => x.toLocaleLowerCase() !== lower)].slice(0, MAX_QUERIES);
  if (queries.join("\n") === prev.queries.join("\n")) return;
  save({ ...prev, queries });
}

export function addRecentResult(result: Omit<RecentResult, "at">) {
  const prev = getRecentSearch();
  const results = [{ ...result, at: Date.now() }, ...prev.results.filter((r) => r.key !== result.key)].slice(0, MAX_RESULTS);
  save({ ...prev, results });
}

export function removeRecentQuery(query: string) {
  const prev = getRecentSearch();
  save({ ...prev, queries: prev.queries.filter((q) => q !== query) });
}

export function clearRecentSearch() {
  save(EMPTY);
}
