/** Plain calendar-date helpers for `YYYY-MM-DD` strings — local dates with no
 * time or zone, so nothing here ever goes through UTC (`toISOString()` is a
 * day off east of UTC for the first hours of the day). Used by DatePicker. */

export interface Ymd {
  y: number;
  /** 0–11 */
  m: number;
  d: number;
}

const pad = (n: number) => String(n).padStart(2, "0");

export function formatYmd({ y, m, d }: Ymd): string {
  return `${String(y).padStart(4, "0")}-${pad(m + 1)}-${pad(d)}`;
}

export function parseYmd(s: string | null | undefined): Ymd | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s ?? "");
  if (!match) return null;
  const y = Number(match[1]);
  const m = Number(match[2]) - 1;
  const d = Number(match[3]);
  if (m < 0 || m > 11 || d < 1 || d > daysInMonth(y, m)) return null;
  return { y, m, d };
}

export function toYmd(date: Date): Ymd {
  return { y: date.getFullYear(), m: date.getMonth(), d: date.getDate() };
}

/** Today in the device's own time zone. */
export function todayYmd(now = new Date()): string {
  return formatYmd(toYmd(now));
}

export function daysInMonth(y: number, m: number): number {
  return new Date(y, m + 1, 0).getDate();
}

/** Local noon avoids DST-midnight edge cases when doing day arithmetic. */
function toDate({ y, m, d }: Ymd): Date {
  const date = new Date(2000, 0, 1, 12);
  date.setFullYear(y, m, d);
  return date;
}

export function addDays(s: string, n: number): string {
  const p = parseYmd(s);
  if (!p) return s;
  const date = toDate(p);
  date.setDate(date.getDate() + n);
  return formatYmd(toYmd(date));
}

/** Same day-of-month `n` months away, clamped to that month's length (31 Jan + 1 month = 28/29 Feb). */
export function addMonths(s: string, n: number): string {
  const p = parseYmd(s);
  if (!p) return s;
  const total = p.y * 12 + p.m + n;
  const y = Math.floor(total / 12);
  const m = total - y * 12;
  return formatYmd({ y, m, d: Math.min(p.d, daysInMonth(y, m)) });
}

/** 0 = Sunday … 6 = Saturday. */
export function dayOfWeek(s: string): number {
  const p = parseYmd(s);
  return p ? toDate(p).getDay() : 0;
}

/** Zero-padded strings compare correctly as plain strings. */
export function clampYmd(s: string, min?: string | null, max?: string | null): string {
  if (min && s < min) return min;
  if (max && s > max) return max;
  return s;
}

export function inRange(s: string, min?: string | null, max?: string | null): boolean {
  return !(min && s < min) && !(max && s > max);
}

/** First day of the week containing `s`, for a week starting on `weekStart` (0 = Sunday). */
export function startOfWeek(s: string, weekStart: number): string {
  return addDays(s, -((dayOfWeek(s) - weekStart + 7) % 7));
}

export function endOfWeek(s: string, weekStart: number): string {
  return addDays(startOfWeek(s, weekStart), 6);
}

/** Six full weeks covering month `m` of year `y` — a fixed-height grid, so the
 * dialog doesn't change size between months. */
export function monthGrid(y: number, m: number, weekStart: number): string[][] {
  let cursor = startOfWeek(formatYmd({ y, m, d: 1 }), weekStart);
  const weeks: string[][] = [];
  for (let w = 0; w < 6; w++) {
    const week: string[] = [];
    for (let i = 0; i < 7; i++) {
      week.push(cursor);
      cursor = addDays(cursor, 1);
    }
    weeks.push(week);
  }
  return weeks;
}

// Regions whose weeks start on Sunday or Saturday (CLDR); everyone else, Monday.
const SUNDAY_REGIONS = new Set("AG AS BD BR BS BT BW BZ CA CN CO DM DO ET GT GU HK HN ID IL IN JM JP KE KH KR LA MH MM MO MT MX MZ NI NP PA PE PH PK PR PT PY SA SG SV TH TT TW UM US VE VI WS YE ZA ZW".split(" "));
const SATURDAY_REGIONS = new Set("AE AF BH DJ DZ EG IQ IR JO KW LY OM QA SD SY".split(" "));
// Language → likely region, for bare language tags like "fa" or "en".
const LIKELY_REGION: Record<string, string> = { fa: "IR", ar: "EG", ps: "AF", en: "US", he: "IL", ja: "JP", zh: "CN", ko: "KR", pt: "BR", hi: "IN" };

/** The locale's first day of the week, 0 = Sunday … 6 = Saturday. Uses
 * `Intl.Locale#getWeekInfo` where the browser has it, otherwise a CLDR table. */
export function weekStartFor(locale: string): number {
  try {
    const loc = new Intl.Locale(locale) as Intl.Locale & {
      getWeekInfo?: () => { firstDay: number };
      weekInfo?: { firstDay: number };
    };
    const info = loc.getWeekInfo?.() ?? loc.weekInfo;
    if (info?.firstDay) return info.firstDay % 7; // 1 = Monday … 7 = Sunday
    const region = loc.region ?? LIKELY_REGION[loc.language] ?? "";
    if (SUNDAY_REGIONS.has(region)) return 0;
    if (SATURDAY_REGIONS.has(region)) return 6;
    return 1;
  } catch {
    return 0;
  }
}

/** The locale, pinned to the Gregorian calendar — some locales (fa → Solar
 * Hijri, th → Buddhist) default to another calendar, whose month names
 * wouldn't match a Gregorian grid. */
export function gregorianLocale(locale: string): string {
  try {
    return new Intl.Locale(locale, { calendar: "gregory" }).toString();
  } catch {
    return "en-u-ca-gregory";
  }
}

/** A Date for formatting with Intl (local noon, so no zone can shift the day). */
export function ymdToDate(s: string): Date {
  const p = parseYmd(s);
  return p ? toDate(p) : new Date(NaN);
}
