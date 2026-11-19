import { Fragment } from "react";
import { findMatchRanges, type MatchMode } from "@/hooks/use-global-search";

/** Renders `text` with the parts that match the search wrapped in <mark>.
 * Plain React text nodes, never HTML, so user content can't inject markup.
 * The mark only changes colour, not weight or size: a Persian or Arabic word
 * split across the mark keeps its joined letter shapes. */
export function Highlight({ text, terms, mode = "prefix" }: { text: string; terms: string[]; mode?: MatchMode }) {
  const ranges = findMatchRanges(text, terms, mode);
  if (ranges.length === 0) return <>{text}</>;
  const parts: React.ReactNode[] = [];
  let at = 0;
  ranges.forEach(([start, end], i) => {
    if (start > at) parts.push(<Fragment key={`t${i}`}>{text.slice(at, start)}</Fragment>);
    parts.push(
      <mark key={`m${i}`} className="rounded-[3px] bg-accent-soft text-accent-text [box-decoration-break:clone]">
        {text.slice(start, end)}
      </mark>,
    );
    at = end;
  });
  if (at < text.length) parts.push(<Fragment key="rest">{text.slice(at)}</Fragment>);
  return <>{parts}</>;
}
