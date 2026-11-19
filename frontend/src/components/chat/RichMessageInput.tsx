"use client";

import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { cn } from "@/lib/cn";
import { resolveMediaUrl } from "@/lib/media-url";

/** An animated emoji placed inside message text. `offset`/`length` are UTF-16
 * positions of its unicode fallback in the serialized text. */
export interface InlineEmoji {
  offset: number;
  length: number;
  packItemId: string;
  relativePath: string;
  stillPath?: string;
  packId?: string;
}

export interface InlineEmojiPick {
  packItemId: string;
  packId: string;
  /** Small animated variant. */
  relativePath: string;
  /** First-frame still (shown instead when animated media is off). */
  stillPath?: string;
  /** What to actually show in the editor (defaults to `relativePath`). */
  displayPath?: string;
  /** Unicode stand-in stored in the text (previews, search, old clients). */
  fallback: string;
}

export interface RichMessageInputHandle {
  focus: () => void;
  insertText: (text: string) => void;
  insertEmoji: (pick: InlineEmojiPick) => void;
  /** Replace everything (edit mode prefill / clearing after send). */
  setContent: (text: string, emoji?: InlineEmoji[]) => void;
  /** Text from the start of the caret's text node up to the caret — enough
   *  to detect an `@mention` being typed. */
  textBeforeCaret: () => string;
  /** Replace the `count` characters right before the caret with `text`. */
  replaceBeforeCaret: (count: number, text: string) => void;
}

interface Props {
  placeholder: string;
  ariaLabel: string;
  onChange: (text: string, emoji: InlineEmoji[]) => void;
  onKeyDown?: (e: React.KeyboardEvent<HTMLDivElement>) => void;
  /** Fires on caret moves too (for mention detection). */
  onCaretChange?: () => void;
  className?: string;
  ariaProps?: Record<string, string | boolean | undefined>;
  /** Show inline animated emoji as their still frame (animated media off). */
  staticEmoji?: boolean;
}

const EMOJI_CLASS = "inline-emoji";

function escapeAttr(s: string) {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

/** HTML for `insertHTML` (which keeps the browser's undo stack working).
 * Every interpolated value is attribute-escaped. */
type EmojiNodeData = { packItemId: string; packId?: string; relativePath: string; stillPath?: string; displayPath?: string; fallback: string };

function emojiHtml(pick: EmojiNodeData) {
  return `<img class="${EMOJI_CLASS}" src="${escapeAttr(resolveMediaUrl(pick.displayPath ?? pick.relativePath))}" alt="${escapeAttr(pick.fallback)}" data-item-id="${escapeAttr(pick.packItemId)}" data-pack-id="${escapeAttr(pick.packId ?? "")}" data-path="${escapeAttr(pick.relativePath)}" data-still="${escapeAttr(pick.stillPath ?? "")}" data-fallback="${escapeAttr(pick.fallback)}" draggable="false">`;
}

function emojiElement(pick: EmojiNodeData) {
  const img = document.createElement("img");
  img.className = EMOJI_CLASS;
  img.src = resolveMediaUrl(pick.displayPath ?? pick.relativePath);
  img.alt = pick.fallback;
  img.draggable = false;
  img.dataset.itemId = pick.packItemId;
  img.dataset.packId = pick.packId ?? "";
  img.dataset.path = pick.relativePath;
  img.dataset.still = pick.stillPath ?? "";
  img.dataset.fallback = pick.fallback;
  return img;
}

/** DOM → plain text + inline emoji spans. Blocks and <br> become "\n";
 * the browser's own trailing placeholder <br> is ignored. */
export function serializeEditor(root: HTMLElement): { text: string; emoji: InlineEmoji[] } {
  let text = "";
  const emoji: InlineEmoji[] = [];
  const walk = (node: Node, isLastInRoot: boolean) => {
    if (node.nodeType === Node.TEXT_NODE) {
      text += (node.nodeValue ?? "").replace(/ /g, " ").replace(/​/g, "");
      return;
    }
    if (!(node instanceof HTMLElement)) return;
    if (node.tagName === "BR") {
      if (!isLastInRoot) text += "\n";
      return;
    }
    if (node.tagName === "IMG" && node.dataset.itemId) {
      const fallback = node.dataset.fallback || "🙂";
      emoji.push({
        offset: text.length,
        length: fallback.length,
        packItemId: node.dataset.itemId,
        relativePath: node.dataset.path ?? "",
        stillPath: node.dataset.still || undefined,
        packId: node.dataset.packId || undefined,
      });
      text += fallback;
      return;
    }
    const block = node.tagName === "DIV" || node.tagName === "P";
    if (block && text.length > 0 && !text.endsWith("\n")) text += "\n";
    const kids = Array.from(node.childNodes);
    kids.forEach((k, i) => walk(k, isLastInRoot && i === kids.length - 1));
  };
  const kids = Array.from(root.childNodes);
  kids.forEach((k, i) => walk(k, i === kids.length - 1));
  return { text, emoji };
}

function buildContent(root: HTMLElement, text: string, emoji: InlineEmoji[] = [], staticEmoji = false) {
  root.textContent = "";
  const sorted = [...emoji].sort((a, b) => a.offset - b.offset);
  let pos = 0;
  const appendText = (t: string) => {
    t.split("\n").forEach((line, i) => {
      if (i > 0) root.appendChild(document.createElement("br"));
      if (line) root.appendChild(document.createTextNode(line));
    });
  };
  for (const e of sorted) {
    if (e.offset < pos) continue;
    appendText(text.slice(pos, e.offset));
    root.appendChild(
      emojiElement({ ...e, displayPath: staticEmoji && e.stillPath ? e.stillPath : undefined, fallback: text.slice(e.offset, e.offset + e.length) }),
    );
    pos = e.offset + e.length;
  }
  appendText(text.slice(pos));
  // Chrome needs a trailing <br> to show a final empty line.
  if (text.endsWith("\n")) root.appendChild(document.createElement("br"));
}

/** A contenteditable message field that can hold animated emoji inline,
 * like Telegram's composer, while behaving like a plain textarea everywhere
 * else: paste is plain text only, Enter/Shift+Enter handling is left to the
 * caller, and it grows with its content up to the caller's max height. */
export const RichMessageInput = forwardRef<RichMessageInputHandle, Props>(function RichMessageInput(
  { placeholder, ariaLabel, onChange, onKeyDown, onCaretChange, className, ariaProps, staticEmoji = false },
  ref,
) {
  const rootRef = useRef<HTMLDivElement>(null);
  const savedRange = useRef<Range | null>(null);
  const [empty, setEmpty] = useState(true);
  const onChangeRef = useRef(onChange);
  const onCaretRef = useRef(onCaretChange);
  useEffect(() => {
    onChangeRef.current = onChange;
    onCaretRef.current = onCaretChange;
  });

  const emit = useCallback(() => {
    const root = rootRef.current;
    if (!root) return;
    const { text, emoji } = serializeEditor(root);
    setEmpty(text.length === 0 && emoji.length === 0);
    onChangeRef.current(text, emoji);
  }, []);

  // Remember the caret even after focus moves to the emoji picker, so a pick
  // lands where the user left off instead of at the end.
  useEffect(() => {
    const onSel = () => {
      const root = rootRef.current;
      const sel = document.getSelection();
      if (!root || !sel || sel.rangeCount === 0) return;
      const range = sel.getRangeAt(0);
      if (root.contains(range.startContainer)) {
        savedRange.current = range.cloneRange();
        onCaretRef.current?.();
      }
    };
    document.addEventListener("selectionchange", onSel);
    return () => document.removeEventListener("selectionchange", onSel);
  }, []);

  // Inserts at the remembered caret WITHOUT taking focus: a pick from the emoji panel must not
  // bring up the on-screen keyboard. The field's own selection follows only if it already has focus.
  const insertAtCaret = useCallback(
    (makeNode: () => Node) => {
      const root = rootRef.current;
      if (!root) return;
      let r: Range;
      if (savedRange.current && root.contains(savedRange.current.startContainer)) {
        r = savedRange.current.cloneRange();
      } else {
        r = document.createRange();
        r.selectNodeContents(root);
        r.collapse(false);
      }
      r.deleteContents();
      const node = makeNode();
      const last = node.lastChild ?? node;
      r.insertNode(node);
      r.setStartAfter(last);
      r.collapse(true);
      savedRange.current = r.cloneRange();
      if (document.activeElement === root) {
        const sel = document.getSelection();
        sel?.removeAllRanges();
        sel?.addRange(r);
      }
      emit();
    },
    [emit],
  );

  const saveCaret = useCallback(() => {
    const sel = document.getSelection();
    if (sel && sel.rangeCount && rootRef.current?.contains(sel.getRangeAt(0).startContainer)) {
      savedRange.current = sel.getRangeAt(0).cloneRange();
    }
  }, []);

  const restoreCaret = useCallback(() => {
    const root = rootRef.current;
    if (!root) return;
    root.focus({ preventScroll: true });
    const sel = document.getSelection();
    if (!sel) return;
    const r = savedRange.current;
    sel.removeAllRanges();
    if (r && root.contains(r.startContainer)) {
      sel.addRange(r);
    } else {
      const end = document.createRange();
      end.selectNodeContents(root);
      end.collapse(false);
      sel.addRange(end);
    }
  }, []);

  useImperativeHandle(
    ref,
    () => ({
      focus: () => restoreCaret(),
      insertText: (t) => insertAtCaret(() => document.createTextNode(t)),
      insertEmoji: (pick) =>
        insertAtCaret(() => {
          const tpl = document.createElement("template");
          tpl.innerHTML = emojiHtml({ ...pick, displayPath: pick.displayPath ?? (staticEmoji && pick.stillPath ? pick.stillPath : undefined) });
          return tpl.content;
        }),
      setContent: (text, emoji) => {
        const root = rootRef.current;
        if (!root) return;
        buildContent(root, text, emoji, staticEmoji);
        savedRange.current = null;
        emit();
      },
      textBeforeCaret: () => {
        const sel = document.getSelection();
        if (!sel || sel.rangeCount === 0) return "";
        const r = sel.getRangeAt(0);
        if (!rootRef.current?.contains(r.startContainer) || r.startContainer.nodeType !== Node.TEXT_NODE) return "";
        return (r.startContainer.nodeValue ?? "").slice(0, r.startOffset);
      },
      replaceBeforeCaret: (count, t) => {
        restoreCaret();
        const sel = document.getSelection();
        if (!sel || sel.rangeCount === 0) return;
        const r = sel.getRangeAt(0);
        if (r.startContainer.nodeType === Node.TEXT_NODE) {
          const start = Math.max(0, r.startOffset - count);
          r.setStart(r.startContainer, start);
          sel.removeAllRanges();
          sel.addRange(r);
        }
        document.execCommand("insertText", false, t);
        emit();
      },
    }),
    [emit, insertAtCaret, restoreCaret, staticEmoji],
  );

  return (
    <div className="relative min-w-0 flex-1">
      {empty ? (
        <span aria-hidden className="pointer-events-none absolute inset-x-0 top-0 truncate py-[10px] ps-4 text-[15.5px] leading-[1.45] text-muted">
          {placeholder}
        </span>
      ) : null}
      <div
        ref={rootRef}
        role="textbox"
        aria-multiline="true"
        aria-label={ariaLabel}
        contentEditable
        suppressContentEditableWarning
        dir="auto"
        spellCheck
        onInput={() => {
          saveCaret();
          emit();
        }}
        onKeyDown={onKeyDown}
        onPaste={(e) => {
          e.preventDefault();
          const t = e.clipboardData.getData("text/plain");
          if (t) document.execCommand("insertText", false, t);
        }}
        onDrop={(e) => e.preventDefault()}
        {...ariaProps}
        className={cn(
          // dir="auto" + `unicode-bidi: plaintext` (globals.css): each line
          // takes its direction from its first strong character while typing.
          // Physical padding — `ps-` would follow the text's direction and
          // jump to the other side as soon as a Persian letter is typed.
          "max-h-[168px] min-h-11 overflow-y-auto whitespace-pre-wrap break-words py-[10px] pl-4 pr-2 text-start text-[15.5px] leading-[1.45] text-fg outline-none focus-visible:outline-none [overflow-wrap:anywhere]",
          "[&_img.inline-emoji]:inline-block [&_img.inline-emoji]:size-[1.3em] [&_img.inline-emoji]:align-[-0.28em] [&_img.inline-emoji]:object-contain",
          className,
        )}
      />
    </div>
  );
});
