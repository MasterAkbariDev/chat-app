"use client";

import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronLeft, ChevronRight } from "lucide-react";
import { Dialog } from "@/components/ui/Dialog";
import { IconButton } from "@/components/ui/IconButton";
import { cn } from "@/lib/cn";
import {
  addDays,
  addMonths,
  clampYmd,
  endOfWeek,
  formatYmd,
  gregorianLocale,
  inRange,
  monthGrid,
  parseYmd,
  startOfWeek,
  todayYmd,
  weekStartFor,
  ymdToDate,
} from "@/lib/calendar";

export interface DatePickerProps {
  /** Dialog title, e.g. "Jump to date". */
  title: string;
  /** Picked date, `YYYY-MM-DD` (a local calendar date, no zone). */
  onSelect: (date: string) => void;
  onClose: () => void;
  /** Initially selected date (`YYYY-MM-DD`). */
  value?: string | null;
  /** Earliest / latest selectable date (`YYYY-MM-DD`, inclusive). */
  min?: string | null;
  max?: string | null;
  /** Days before this still work but are dimmed — e.g. before a chat's first message. */
  dimBefore?: string | null;
  /** BCP 47 locale for month/day names and the week's first day. Defaults to the device's. */
  locale?: string;
  /** Override the locale's first day of the week (0 = Sunday … 6 = Saturday). */
  weekStartsOn?: number;
}

type View = "days" | "months";

function deviceLocale() {
  if (typeof navigator === "undefined") return "en";
  return navigator.languages?.[0] ?? navigator.language ?? "en";
}

/**
 * A calendar in a Dialog (centred card on desktop, bottom sheet on phones),
 * following the WAI-ARIA "date picker dialog" pattern: focus moves to the
 * selected (or today's) day; arrows move by day/week (mirrored in RTL),
 * Home/End to the week's start/end, PageUp/PageDown by month and with Shift
 * by year, Enter/Space picks, Esc closes and focus returns to the opener
 * (Dialog). The month heading switches to a month/year grid. Month and
 * weekday names, digits and the week's first day come from `Intl` for the
 * locale, always on the Gregorian calendar.
 */
export function DatePicker({ title, onSelect, onClose, value, min, max, dimBefore, locale: localeProp, weekStartsOn }: DatePickerProps) {
  const [locale] = useState(() => gregorianLocale(localeProp ?? deviceLocale()));
  const weekStart = weekStartsOn ?? weekStartFor(localeProp ?? deviceLocale());
  const [today] = useState(todayYmd);
  const selected = parseYmd(value) ? value! : null;
  const [focused, setFocused] = useState(() => clampYmd(selected ?? today, min, max));
  const [view, setView] = useState<View>("days");
  // Year shown in the month/year view.
  const [year, setYear] = useState(() => parseYmd(focused)!.y);
  const gridRef = useRef<HTMLTableElement>(null);
  const monthsRef = useRef<HTMLDivElement>(null);
  const moveFocusRef = useRef(false);
  const headingId = useId();

  const f = parseYmd(focused)!;
  const weeks = useMemo(() => monthGrid(f.y, f.m, weekStart), [f.y, f.m, weekStart]);

  const fmt = useMemo(
    () => ({
      heading: new Intl.DateTimeFormat(locale, { month: "long", year: "numeric" }),
      month: new Intl.DateTimeFormat(locale, { month: "long" }),
      monthShort: new Intl.DateTimeFormat(locale, { month: "short" }),
      year: new Intl.DateTimeFormat(locale, { year: "numeric" }),
      day: new Intl.DateTimeFormat(locale, { day: "numeric" }),
      full: new Intl.DateTimeFormat(locale, { weekday: "long", day: "numeric", month: "long", year: "numeric" }),
      weekdayNarrow: new Intl.DateTimeFormat(locale, { weekday: "narrow" }),
      weekdayLong: new Intl.DateTimeFormat(locale, { weekday: "long" }),
    }),
    [locale],
  );

  // After keyboard navigation, move DOM focus to the newly focused day.
  useLayoutEffect(() => {
    if (!moveFocusRef.current) return;
    moveFocusRef.current = false;
    if (view === "days") gridRef.current?.querySelector<HTMLElement>('[tabindex="0"]')?.focus();
    else monthsRef.current?.querySelector<HTMLElement>("[data-current]")?.focus();
  }, [focused, view]);

  // Opening the month/year view puts focus on the current month.
  useEffect(() => {
    if (view === "months") monthsRef.current?.querySelector<HTMLElement>("[data-current]")?.focus();
  }, [view]);

  function go(next: string, focus = true) {
    setFocused(clampYmd(next, min, max));
    moveFocusRef.current = focus;
  }

  function pick(date: string) {
    if (!inRange(date, min, max)) return;
    onSelect(date);
  }

  function onGridKeyDown(e: React.KeyboardEvent) {
    const rtl = getComputedStyle(e.currentTarget).direction === "rtl";
    const back = rtl ? 1 : -1;
    let next: string | null = null;
    switch (e.key) {
      case "ArrowLeft":
        next = addDays(focused, back);
        break;
      case "ArrowRight":
        next = addDays(focused, -back);
        break;
      case "ArrowUp":
        next = addDays(focused, -7);
        break;
      case "ArrowDown":
        next = addDays(focused, 7);
        break;
      case "Home":
        next = startOfWeek(focused, weekStart);
        break;
      case "End":
        next = endOfWeek(focused, weekStart);
        break;
      case "PageUp":
        next = addMonths(focused, e.shiftKey ? -12 : -1);
        break;
      case "PageDown":
        next = addMonths(focused, e.shiftKey ? 12 : 1);
        break;
      case "Enter":
      case " ":
        e.preventDefault();
        pick(focused);
        return;
      default:
        return;
    }
    e.preventDefault();
    go(next);
  }

  const firstOfMonth = formatYmd({ y: f.y, m: f.m, d: 1 });
  const lastOfMonth = addDays(addMonths(firstOfMonth, 1), -1);
  const canPrev = !min || addDays(firstOfMonth, -1) >= min;
  const canNext = !max || addDays(lastOfMonth, 1) <= max;

  const header = (
    <div className="flex items-center gap-1 pb-2">
      <button
        type="button"
        onClick={() => {
          setYear(f.y);
          setView(view === "days" ? "months" : "days");
          if (view === "months") moveFocusRef.current = true;
        }}
        aria-expanded={view === "months"}
        aria-label={view === "days" ? `${fmt.heading.format(ymdToDate(focused))}, choose month and year` : "Back to days"}
        className="pressable -ms-2 flex h-11 min-w-0 flex-1 items-center gap-1.5 rounded-[var(--radius-sm)] px-2 text-start text-[16px] font-semibold text-fg hover:bg-sunken"
      >
        <span id={headingId} aria-live="polite" className="truncate">
          {view === "days" ? fmt.heading.format(ymdToDate(focused)) : fmt.year.format(ymdToDate(formatYmd({ y: year, m: 0, d: 1 })))}
        </span>
        <ChevronDown className={cn("size-4 shrink-0 text-muted transition-transform", view === "months" && "rotate-180")} strokeWidth={2.2} aria-hidden />
      </button>
      {view === "days" ? (
        <>
          <IconButton size="lg" aria-label="Previous month" disabled={!canPrev} onClick={() => go(addMonths(focused, -1), false)}>
            <ChevronLeft className="rtl:rotate-180" strokeWidth={2} />
          </IconButton>
          <IconButton size="lg" aria-label="Next month" disabled={!canNext} onClick={() => go(addMonths(focused, 1), false)}>
            <ChevronRight className="rtl:rotate-180" strokeWidth={2} />
          </IconButton>
        </>
      ) : (
        <>
          <IconButton size="lg" aria-label="Previous year" disabled={!!min && year <= parseYmd(min)!.y} onClick={() => setYear(year - 1)}>
            <ChevronLeft className="rtl:rotate-180" strokeWidth={2} />
          </IconButton>
          <IconButton size="lg" aria-label="Next year" disabled={!!max && year >= parseYmd(max)!.y} onClick={() => setYear(year + 1)}>
            <ChevronRight className="rtl:rotate-180" strokeWidth={2} />
          </IconButton>
        </>
      )}
    </div>
  );

  return (
    <Dialog title={title} onClose={onClose} size="sm" bodyClassName="pt-1 pb-4">
      {header}
      {view === "days" ? (
        <table ref={gridRef} role="grid" aria-labelledby={headingId} onKeyDown={onGridKeyDown} className="w-full table-fixed border-collapse">
          <thead>
            <tr>
              {weeks[0].map((d) => (
                <th key={d} scope="col" abbr={fmt.weekdayLong.format(ymdToDate(d))} className="h-8 text-center text-[12.5px] font-semibold text-muted">
                  {fmt.weekdayNarrow.format(ymdToDate(d))}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {weeks.map((week) => (
              <tr key={week[0]}>
                {week.map((d) => {
                  const p = parseYmd(d)!;
                  const outside = p.m !== f.m;
                  const disabled = !inRange(d, min, max);
                  const isSelected = d === selected;
                  const isToday = d === today;
                  const dim = !!dimBefore && d < dimBefore;
                  return (
                    <td key={d} role="gridcell" aria-selected={isSelected} className="p-0 text-center">
                      <button
                        type="button"
                        tabIndex={d === focused ? 0 : -1}
                        data-autofocus={d === focused ? "" : undefined}
                        aria-label={fmt.full.format(ymdToDate(d))}
                        aria-current={isToday ? "date" : undefined}
                        aria-disabled={disabled || undefined}
                        onClick={() => {
                          if (disabled) return;
                          setFocused(d);
                          pick(d);
                        }}
                        className={cn(
                          "tabular mx-auto flex size-11 items-center justify-center rounded-full text-[15px] transition-colors",
                          isSelected
                            ? "bg-accent font-semibold text-accent-fg hover:bg-accent-hover"
                            : isToday
                              ? "font-bold text-accent-text ring-1 ring-inset ring-accent hover:bg-sunken"
                              : "text-fg hover:bg-sunken",
                          !isSelected && (outside || dim) && "text-muted",
                          !isSelected && outside && dim && "opacity-60",
                          disabled && "cursor-not-allowed opacity-35 hover:bg-transparent",
                        )}
                      >
                        {fmt.day.format(ymdToDate(d))}
                      </button>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <div ref={monthsRef} role="group" aria-labelledby={headingId} className="grid grid-cols-3 gap-2 py-1">
          {Array.from({ length: 12 }, (_, m) => {
            const first = formatYmd({ y: year, m, d: 1 });
            const last = addDays(addMonths(first, 1), -1);
            const disabled = (!!min && last < min) || (!!max && first > max);
            const current = year === f.y && m === f.m;
            return (
              <button
                key={m}
                type="button"
                disabled={disabled}
                data-current={current ? "" : undefined}
                aria-pressed={current}
                aria-label={fmt.heading.format(ymdToDate(first))}
                onClick={() => {
                  go(formatYmd({ y: year, m, d: Math.min(f.d, parseYmd(last)!.d) }));
                  setView("days");
                }}
                className={cn(
                  "pressable h-12 rounded-[var(--radius-sm)] text-[15px] font-medium disabled:opacity-35",
                  current ? "bg-accent text-accent-fg hover:bg-accent-hover" : "bg-sunken text-fg hover:bg-line",
                )}
              >
                {fmt.monthShort.format(ymdToDate(first))}
              </button>
            );
          })}
        </div>
      )}
      <div className="mt-3 flex items-center justify-between gap-2 border-t border-line pt-3">
        <button
          type="button"
          disabled={!inRange(today, min, max)}
          onClick={() => {
            setView("days");
            go(today);
          }}
          className="pressable h-11 rounded-full px-4 text-[14.5px] font-semibold text-accent-text hover:bg-accent-soft disabled:opacity-40"
        >
          Today
        </button>
        <p className="text-end text-[12.5px] text-muted max-sm:hidden">Arrow keys move, Enter picks</p>
      </div>
    </Dialog>
  );
}
