"use client";

import { resolveMediaUrl } from "@/lib/media-url";
import { useEffect, useRef, useState } from "react";
import { AlertCircle, ArrowLeft, Bot, CheckCircle2, ChevronDown, ChevronRight, ChevronUp, Database, Grid2X2, Inbox, Layers3, Puzzle, Search, Server, Settings2, Shield, Sparkles, Users } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog, Dialog } from "@/components/ui/Dialog";
import { EmptyState } from "@/components/ui/EmptyState";
import { Field, Input, Textarea } from "@/components/ui/Field";
import { ListGroup, ListItem } from "@/components/ui/List";
import { PageBody, PageHeader } from "@/components/ui/PageHeader";
import { Skeleton } from "@/components/ui/Skeleton";
import { Switch } from "@/components/ui/Switch";
import { ApiError } from "@/lib/api/client";
import { getBotMenu, getBotMessages, invokeBotAction, invokeBotActionUpload } from "@/lib/api/bots";
import { cn } from "@/lib/cn";
import type { BotAction, BotFormField, BotMenuScreen } from "@/lib/api/types";

export interface BotScreenRendererProps {
  botKey: string;
  initialScreenId?: string;
  initialParams?: Record<string, unknown>;
  onClose?: () => void;
  /** How it's hosted. Defaults to "dialog" when `onClose` is given and
   * "inline" when it isn't (the two existing call sites).
   * - "dialog": a self-contained modal, for click-triggered use (e.g.
   *   "Manage packs" in the sticker picker).
   * - "inline": just the content (screen heading, rows, buttons), filling
   *   whatever container the route gives it — the route supplies its own
   *   PageHeader/PageBody (Settings → Bots → a bot).
   * - "page": a whole screen frame (page root + PageHeader + PageBody);
   *   `onClose` becomes the header's back button. */
  layout?: "dialog" | "inline" | "page";
}

function buttonVariant(style: BotAction["style"]) {
  return style === "destructive" ? "danger" : style === "primary" ? "primary" : "secondary";
}

// One generic renderer for every bot screen — title, rows, page-level
// buttons, all described by the server response (BotMenuScreen). Never
// bot-specific UI, even though pack-manager is the only bot that exists
// today (see docs/PACKS_AND_BOTS_FRONTEND_BRIEF.md §2).
export function BotScreenRenderer({ botKey, initialScreenId, initialParams, onClose, layout: layoutProp }: BotScreenRendererProps) {
  const layout = layoutProp ?? (onClose ? "dialog" : "inline");
  const [screen, setScreen] = useState<BotMenuScreen | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [notices, setNotices] = useState<string[]>([]);
  const [formAction, setFormAction] = useState<BotAction | null>(null);
  const [formValues, setFormValues] = useState<Record<string, unknown>>({});
  const [formFiles, setFormFiles] = useState<File[]>([]);
  const [confirmAction, setConfirmAction] = useState<BotAction | null>(null);
  const [pendingForm, setPendingForm] = useState<{ action: BotAction; values: Record<string, unknown>; files: File[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [pendingActionId, setPendingActionId] = useState<string | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);

  async function load(screenId?: string, params?: Record<string, unknown>) {
    setLoading(true);
    setError(null);
    try {
      const next = await getBotMenu(botKey, screenId, params);
      setScreen(next);
      if (next.toast) setToast(next.toast);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't load this screen. Check your connection and try again.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    // `load` is async and its first line calls setState synchronously
    // (before any `await`) — deferring the call itself to a microtask keeps
    // that setState out of the effect's own synchronous execution, same
    // reasoning as the lazy-initializer pattern used elsewhere in this app,
    // just for a case that's genuinely async and can't be computed inline.
    void Promise.resolve().then(() => load(initialScreenId, initialParams));
    let cancelled = false;
    void getBotMessages(botKey).then(history => { if (!cancelled) setNotices(previous => [...history, ...previous]); }).catch(() => undefined);
    const refresh = setInterval(() => { void getBotMessages(botKey).then(history => { if (!cancelled) setNotices(history); }).catch(() => undefined); }, 15_000);
    return () => { cancelled = true; clearInterval(refresh); };
    // Only ever re-runs via explicit navigate/invoke calls below, not this effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [botKey]);

  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(null), 3500);
    return () => clearTimeout(id);
  }, [toast]);

  // In the dialog layout the form/confirm steps replace the screen inside
  // the same Dialog (so there's only ever one focus trap). When the screen
  // comes back — or the server swaps in a different one — keep focus inside
  // the dialog: on the control that opened the step if it still exists,
  // otherwise on the body itself.
  const mode = formAction ? "form" : confirmAction ? "confirm" : "screen";
  useEffect(() => {
    if (layout !== "dialog" || mode !== "screen") return;
    const el = returnFocusRef.current;
    if (el && document.contains(el) && bodyRef.current?.contains(el)) el.focus({ preventScroll: true });
    else if (!document.activeElement || document.activeElement === document.body) bodyRef.current?.focus({ preventScroll: true });
  }, [layout, mode, screen]);

  function openForm(action: BotAction) {
    setFormValues({});
    setFormFiles([]);
    setFormAction(action);
  }

  function handleAction(action: BotAction) {
    returnFocusRef.current = document.activeElement as HTMLElement | null;
    if (action.type === "navigate") {
      load(action.screenId, action.params);
      return;
    }
    if (action.type === "form") {
      openForm(action);
      return;
    }
    if (action.confirmText) {
      setConfirmAction(action);
      return;
    }
    fireInvoke(action, {});
  }

  async function fireInvoke(action: BotAction, formValues: Record<string, unknown>, files?: File[]) {
    if (!screen) return;
    setBusy(true);
    setPendingActionId(action.id);
    setError(null);
    try {
      const mergedParams = { ...(action.params ?? {}), ...formValues };
      const res =
        files && files.length > 0
          ? await invokeBotActionUpload(botKey, action.id, screen.screenId, mergedParams, files)
          : await invokeBotAction(botKey, action.id, screen.screenId, mergedParams);
      // Always re-render from whatever comes back — the server can navigate
      // somewhere other than where the action fired (e.g. deleting a pack
      // lands on "my packs", not a now-nonexistent pack-detail screen).
      setScreen(res.screen);
      if (res.screen.toast) { setToast(res.screen.toast); setNotices(previous => [...previous.slice(-49), res.screen.toast!]); }
      setFormAction(null);
      setConfirmAction(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "That didn't work. Check your connection and try again.");
    } finally {
      setBusy(false);
      setPendingActionId(null);
    }
  }

  function confirmNow() {
    const action = confirmAction;
    if (!action) return;
    setConfirmAction(null);
    if (pendingForm) {
      fireInvoke(pendingForm.action, pendingForm.values, pendingForm.files);
      setPendingForm(null);
    }
    else if (action.type === "form") openForm(action);
    else fireInvoke(action, {});
  }

  function submitForm() {
    if (!formAction) return;
    const hasFileField = formAction.fields?.some((f) => f.kind === "file");
    const files = hasFileField ? formFiles : [];
    if (formAction.confirmText) {
      setPendingForm({ action: formAction, values: formValues, files });
      const target = typeof formValues.input === "string" ? formValues.input.trim() : "";
      setConfirmAction(target ? { ...formAction, confirmText: `${formAction.confirmText} (${target})` } : formAction);
      setFormAction(null);
    } else fireInvoke(formAction, formValues, files);
  }

  const formBody = formAction ? (
    <BotFormFields
      action={formAction}
      values={formValues}
      error={error}
      onChange={(key, value) => setFormValues((prev) => ({ ...prev, [key]: value }))}
      onFiles={setFormFiles}
    />
  ) : null;

  const formFooter = (
    <>
      <Button type="button" variant="secondary" onClick={() => setFormAction(null)}>
        Cancel
      </Button>
      <Button type="submit" loading={busy}>
        {formAction?.label ?? "Submit"}
      </Button>
    </>
  );

  const screenBody = (
    <ScreenBody
      screen={screen}
      loading={loading}
      toast={toast}
      error={mode === "screen" ? error : null}
      busy={busy}
      onAction={handleAction}
      onRetry={() => load(screen?.screenId ?? initialScreenId, screen ? undefined : initialParams)}
    />
  );

  const actionButtons =
    screen && screen.actions.length > 0
      ? screen.actions.map((action) => (
          <Button
            key={action.id}
            variant={buttonVariant(action.style)}
            onClick={() => handleAction(action)}
            disabled={busy && pendingActionId !== action.id}
            loading={busy && pendingActionId === action.id}
          >
            {action.label}
          </Button>
        ))
      : null;

  const stepDialogs = (
    <>
      {formAction ? (
        <Dialog onClose={() => setFormAction(null)} title={formAction.label} size="sm" onSubmit={submitForm} footer={formFooter}>
          {formBody}
        </Dialog>
      ) : null}

      {confirmAction ? (
        <ConfirmDialog
          title={confirmAction.confirmText ?? confirmAction.label}
          confirmLabel={confirmAction.label}
          destructive={confirmAction.style === "destructive"}
          pending={busy}
          onConfirm={confirmNow}
          onClose={() => { setConfirmAction(null); setPendingForm(null); }}
        />
      ) : null}
    </>
  );

  if (layout === "inline" && screen?.presentation === "conversation") {
    return (
      <>
        <ConversationScreen screen={screen} loading={loading} busy={busy} pendingActionId={pendingActionId} notices={notices} error={mode === "screen" ? error : null} onAction={handleAction} />
        {stepDialogs}
      </>
    );
  }

  if (layout === "inline") {
    return (
      <div className="flex w-full flex-col gap-4">
        <div className="px-1">
          {screen ? (
            <>
              <h2 className="text-[18px] font-bold leading-snug text-fg">{screen.title}</h2>
              {screen.subtitle ? <p className="mt-0.5 text-[14px] text-muted">{screen.subtitle}</p> : null}
            </>
          ) : loading ? (
            <Skeleton className="h-5 w-40" />
          ) : null}
        </div>
        {screenBody}
        {actionButtons ? <div className="flex flex-col gap-2">{actionButtons}</div> : null}
        {stepDialogs}
      </div>
    );
  }

  if (layout === "page") {
    return (
      <div className="flex min-h-0 flex-1 flex-col bg-canvas">
        <PageHeader
          title={screen?.title ?? (loading ? <Skeleton className="h-5 w-40" /> : "Bot")}
          subtitle={screen?.subtitle}
          onBack={onClose}
          backLabel="Back to bots"
          backOnDesktop
        />
        <PageBody width="sm">
          {screenBody}
          {actionButtons ? <div className="flex flex-col gap-2">{actionButtons}</div> : null}
        </PageBody>
        {stepDialogs}
      </div>
    );
  }

  const close = () => {
    if (formAction) setFormAction(null);
    else if (confirmAction) { setConfirmAction(null); setPendingForm(null); }
    else onClose?.();
  };

  return (
    <Dialog
      onClose={close}
      size="md"
      hideClose={!onClose && mode === "screen"}
      title={mode === "form" ? formAction!.label : mode === "confirm" ? (confirmAction!.confirmText ?? confirmAction!.label) : (screen?.title ?? "Loading…")}
      description={mode === "screen" ? screen?.subtitle : undefined}
      onSubmit={mode === "form" ? submitForm : undefined}
      bodyClassName={mode === "confirm" ? "hidden" : undefined}
      footer={
        mode === "form" ? (
          formFooter
        ) : mode === "confirm" ? (
          <>
            <Button variant="secondary" onClick={() => { setConfirmAction(null); setPendingForm(null); }} autoFocus={confirmAction!.style === "destructive"}>
              Cancel
            </Button>
            <Button variant={confirmAction!.style === "destructive" ? "danger" : "primary"} onClick={confirmNow} autoFocus={confirmAction!.style !== "destructive"}>
              {confirmAction!.label}
            </Button>
          </>
        ) : (
          actionButtons
        )
      }
    >
      <div ref={bodyRef} tabIndex={-1} className="outline-none">
        {mode === "form" ? formBody : mode === "screen" ? screenBody : null}
      </div>
    </Dialog>
  );
}

function actionIcon(label: string) {
  const text = label.toLowerCase();
  if (text === "back" || text.startsWith("back to") || text.includes("all services")) return ArrowLeft;
  if (text.includes("player") || text.includes("admin") || text.includes("operator")) return Users;
  if (text.includes("mod")) return Puzzle;
  if (text.includes("backup")) return Database;
  if (text.includes("access") || text.includes("glitch") || text.includes("ban")) return Shield;
  if (text.includes("setting") || text.includes("limit")) return Settings2;
  if (text.includes("server") || text.includes("service")) return Server;
  return Layers3;
}

/** A generic, opt-in conversation-style presentation for server-described bots. */
function ConversationScreen({ screen, loading, busy, pendingActionId, notices, error, onAction }: {
  screen: BotMenuScreen;
  loading: boolean;
  busy: boolean;
  pendingActionId: string | null;
  notices: string[];
  error: string | null;
  onAction: (action: BotAction) => void;
}) {
  const [open, setOpen] = useState(true);
  const [query, setQuery] = useState("");
  useEffect(() => { void Promise.resolve().then(() => setQuery("")); }, [screen.screenId, screen.title]);
  const menuItems = screen.screenId === "resource" || screen.screenId === "home" ? screen.items : [];
  const rows = menuItems.length ? [] : screen.items;
  const back = screen.actions.find(action => action.id === "back");
  const actions = screen.actions.filter(action => action !== back);
  return (
    <section className="relative flex min-h-0 w-full flex-1 flex-col overflow-hidden bg-canvas" aria-busy={loading || busy}>
      {back ? <div className="z-10 shrink-0 border-b border-line bg-panel px-3"><button type="button" onClick={() => onAction(back)} disabled={busy || loading} className="flex min-h-12 items-center gap-2 rounded-xl px-2 text-sm font-bold text-accent-text transition hover:bg-accent-soft disabled:opacity-50"><ArrowLeft className="size-5" aria-hidden />{back.label}</button></div> : null}
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto bg-[radial-gradient(ellipse_at_90%_0%,rgba(99,102,241,0.12),transparent_48%),radial-gradient(ellipse_at_0%_80%,rgba(20,184,166,0.08),transparent_45%)] px-3 py-5 sm:px-6" aria-live="polite">
        <div className="self-center rounded-full border border-line bg-panel/80 px-3 py-1 text-[11px] font-semibold tracking-wide text-muted shadow-sm">YOUR BOT CONVERSATION</div>
        {notices.map((notice, i) => { const failed=/\b(failed|error|unable|unavailable)\b/i.test(notice); const NoticeIcon=failed?AlertCircle:CheckCircle2; return <div key={`${i}-${notice}`} className="flex items-start gap-2"><span className={cn("flex size-8 shrink-0 items-center justify-center rounded-full",failed?"bg-danger-soft text-danger":"bg-success-soft text-success")}><NoticeIcon className="size-4" aria-hidden /></span><div className={cn("min-w-0 rounded-2xl rounded-tl-sm border px-4 py-3 text-sm shadow-sm",failed?"border-danger/20 bg-danger-soft text-danger":"border-success/20 bg-panel text-fg")}><span className={cn("mb-1 block text-[11px] font-bold uppercase tracking-wide",failed?"text-danger":"text-success")}>{failed?"Needs attention":"Update"}</span><p className="break-words leading-relaxed">{notice}</p></div></div>; })}
        <div className="flex items-start gap-2.5">
          <span className="mt-1 flex size-9 shrink-0 items-center justify-center rounded-2xl bg-accent text-accent-fg shadow-sm" aria-hidden><Bot className="size-5" /></span>
          <div className="min-w-0 flex-1 overflow-hidden rounded-[22px] rounded-tl-md border border-line bg-panel shadow-sm">
            <div className="h-1 bg-gradient-to-r from-indigo-500 via-violet-500 to-teal-400" />
            <div className="p-4 sm:p-5">
            <div className="mb-1 flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider text-accent-text"><Sparkles className="size-3.5" aria-hidden />Controls</div>
            <h2 className="text-xl font-bold leading-snug tracking-tight text-fg">{screen.title}</h2>
            {screen.subtitle ? <div className="mt-3 space-y-2 break-words text-[14px] leading-relaxed">{screen.subtitle.split('\n').map((line,i)=>{const match=/^([^:]{1,35}):\s*(.*)$/.exec(line);const content=match?match[2]:line;const tone=/\b(offline|stopped|failed|disabled|unavailable)\b/i.test(content)?'text-danger':/\b(online|running|enabled|prepared)\b/i.test(content)?'text-success':'text-fg';return <p key={i} className={cn("break-words",tone)}>{match?<span className="font-semibold text-muted">{match[1]}: </span>:null}{content.split(/(https?:\/\/[^\s]+)/g).map((part,j)=>/^https?:\/\//.test(part)?<a key={j} href={part} target="_blank" rel="noopener noreferrer" className="text-accent-text underline underline-offset-2">{part}</a>:part)}</p>})}</div> : null}
            {error ? <p role="alert" className="mt-4 rounded-xl bg-danger-soft px-3 py-2 text-sm text-danger">{error}</p> : null}
            {rows.length > 8 ? <div className="relative mt-4"><Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted" aria-hidden /><input aria-label="Search list" placeholder="Search this list…" value={query} onChange={e => setQuery(e.target.value)} className="h-12 w-full rounded-xl border border-line bg-sunken pl-10 pr-3 text-sm text-fg outline-none focus:border-accent" /></div> : null}
            {rows.length ? <div className="mt-4 overflow-hidden rounded-2xl border border-line">{rows.filter(item => rows.length <= 8 || item.title.toLowerCase().includes(query.toLowerCase())).map((item, index) => {
              const Icon = actionIcon(item.title);
              const rule = /^(On|Off|Unavailable) · (.+)$/.exec(item.subtitle ?? "");
              return <button key={item.id} type="button" onClick={() => onAction(item.action)} disabled={busy || loading} className={cn("flex min-h-16 w-full items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-accent-soft disabled:opacity-50", index > 0 && "border-t border-line")}><span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-accent-soft text-accent-text"><Icon className="size-[18px]" aria-hidden /></span><span className="min-w-0 flex-1"><span className="block break-words text-sm font-semibold text-fg">{item.title}</span>{rule ? <span className="mt-1 flex flex-wrap items-center gap-2"><span className={cn("rounded-full px-2 py-0.5 text-[11px] font-bold", rule[1] === "On" ? "bg-success-soft text-success" : "bg-sunken text-muted")}>{rule[1]}</span><span className="text-xs text-muted">{rule[2]}</span></span> : item.subtitle ? <span className={cn("mt-0.5 block text-xs font-medium", /^enabled$/i.test(item.subtitle)?"text-success":"text-muted")}>{item.subtitle}</span> : null}</span><ChevronRight className="size-4 shrink-0 text-muted rtl:rotate-180" aria-hidden /></button>;
            })}</div> : null}
            </div>
          </div>
        </div>
      </div>
      <div className="z-10 shrink-0 rounded-t-[22px] border-t border-line bg-panel shadow-[0_-8px_32px_rgba(0,0,0,0.12)]">
        <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} className="flex min-h-14 w-full items-center gap-3 px-4 text-left text-sm font-bold text-fg hover:bg-sunken"><span className="flex size-9 items-center justify-center rounded-xl bg-accent-soft text-accent-text"><Grid2X2 className="size-[18px]" /></span><span className="flex-1">{open ? "Controls" : "Show controls"}</span><span className="flex size-8 items-center justify-center rounded-full bg-sunken text-muted">{open ? <ChevronDown className="size-5" /> : <ChevronUp className="size-5" />}</span></button>
        {open ? <div className="max-h-[min(38dvh,310px)] overflow-y-auto px-3 pb-3"><div className="grid grid-cols-2 gap-2">
          {menuItems.map((item, index) => { const Icon = actionIcon(item.title); const colors = ["bg-indigo-500/15 text-indigo-500", "bg-emerald-500/15 text-emerald-600", "bg-amber-500/15 text-amber-600", "bg-fuchsia-500/15 text-fuchsia-500", "bg-sky-500/15 text-sky-600", "bg-rose-500/15 text-rose-500"]; return <button key={item.id} type="button" onClick={() => onAction(item.action)} disabled={busy || loading} className="flex min-h-16 items-center gap-2.5 rounded-2xl border border-line bg-panel px-3 py-2 text-left text-sm font-bold text-fg shadow-sm transition hover:border-accent hover:bg-accent-soft disabled:opacity-50"><span className={cn("flex size-10 shrink-0 items-center justify-center rounded-xl", colors[index % colors.length])}><Icon className="size-5" /></span><span className="min-w-0 flex-1">{item.title}</span><ChevronRight className="size-4 shrink-0 text-muted" /></button>; })}
          {actions.map(action => { const Icon = actionIcon(action.label); return <button key={action.id} type="button" onClick={() => onAction(action)} disabled={busy || loading} className={cn("flex min-h-12 items-center gap-2.5 rounded-xl border border-line px-3 py-2 text-left text-sm font-semibold transition disabled:opacity-50", action.style === "destructive" ? "bg-danger-soft text-danger" : "bg-accent-soft text-accent-text hover:border-accent")}><Icon className="size-[18px] shrink-0" /><span>{busy && pendingActionId === action.id ? "Working…" : action.label}</span></button>; })}
        </div></div> : null}
      </div>
    </section>
  );
}

function ScreenBody({
  screen,
  loading,
  toast,
  error,
  busy,
  onAction,
  onRetry,
}: {
  screen: BotMenuScreen | null;
  loading: boolean;
  toast: string | null;
  error: string | null;
  busy: boolean;
  onAction: (action: BotAction) => void;
  onRetry: () => void;
}) {
  return (
    <div className="flex flex-col gap-4 pb-1">
      <div role="status" aria-live="polite" className="empty:hidden">
        {toast ? (
          <div className="fade-in flex items-center gap-2.5 rounded-[var(--radius-md)] bg-success-soft px-3.5 py-3 text-[14px] font-medium text-success">
            <CheckCircle2 className="size-[18px] shrink-0" strokeWidth={1.8} aria-hidden />
            <span className="min-w-0">{toast}</span>
          </div>
        ) : null}
      </div>

      {error ? (
        <div role="alert" className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-[var(--radius-md)] bg-danger-soft px-3.5 py-3 text-[14px] text-danger">
          <span className="min-w-0 flex-1">{error}</span>
          {!screen ? (
            <button type="button" onClick={onRetry} className="shrink-0 font-semibold underline underline-offset-2">
              Try again
            </button>
          ) : null}
        </div>
      ) : null}

      {loading && !screen ? (
        <div role="status" aria-label="Loading" className="overflow-hidden rounded-[var(--radius-md)] border border-line bg-panel">
          {Array.from({ length: 3 }, (_, i) => (
            <div key={i} className={cn("flex min-h-[60px] items-center gap-3 px-4 py-2.5", i > 0 && "border-t border-line")}>
              <Skeleton className="size-10 shrink-0 rounded-[var(--radius-sm)]" />
              <div className="flex flex-1 flex-col gap-2">
                <Skeleton className="h-3 w-2/5" />
                <Skeleton className="h-2.5 w-3/5" />
              </div>
            </div>
          ))}
        </div>
      ) : !screen ? null : screen.items.length === 0 ? (
        <EmptyState icon={Inbox} title="Nothing here yet" className="py-6" />
      ) : (
        <div aria-busy={loading || undefined} className={cn("transition-opacity", loading && "opacity-60")}>
          <ListGroup>
            {screen.items.map((item) => (
              <ListItem
                key={item.id}
                onClick={() => onAction(item.action)}
                disabled={busy || loading}
                leading={
                  item.imageUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element -- remote, backend-hosted
                    <img src={/^(https?:|blob:|data:)/.test(item.imageUrl) ? item.imageUrl : resolveMediaUrl(item.imageUrl)} alt="" className="size-10 shrink-0 rounded-[var(--radius-sm)] bg-sunken object-cover" />
                  ) : undefined
                }
                title={item.title}
                subtitle={item.subtitle}
                trailing={
                  item.badge || item.action.type === "navigate" ? (
                    <>
                      {item.badge ? (
                        <span className="rounded-full bg-accent-soft px-2 py-0.5 text-[12.5px] font-semibold text-accent-text">{item.badge}</span>
                      ) : null}
                      {item.action.type === "navigate" ? (
                        <ChevronRight className="size-[18px] text-muted rtl:rotate-180" strokeWidth={1.8} aria-hidden />
                      ) : null}
                    </>
                  ) : undefined
                }
              />
            ))}
          </ListGroup>
        </div>
      )}
    </div>
  );
}

function BotFormFields({
  action,
  values,
  error,
  onChange,
  onFiles,
}: {
  action: BotAction;
  values: Record<string, unknown>;
  error: string | null;
  onChange: (key: string, value: unknown) => void;
  onFiles: (files: File[]) => void;
}) {
  return (
    <div className="flex flex-col gap-4 pb-2">
      {(action.fields ?? []).map((field, i) => (
        <BotFormFieldInput
          key={field.key}
          field={field}
          autoFocus={i === 0}
          value={values[field.key]}
          onChange={(v) => onChange(field.key, v)}
          onFiles={onFiles}
        />
      ))}
      {error ? (
        <p role="alert" className="text-[13.5px] text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function BotFormFieldInput({
  field,
  value,
  autoFocus,
  onChange,
  onFiles,
}: {
  field: BotFormField;
  value: unknown;
  autoFocus?: boolean;
  onChange: (value: unknown) => void;
  onFiles: (files: File[]) => void;
}) {
  if (field.kind === "toggle") {
    const checked = !!value;
    return (
      <div className="flex min-h-11 items-center justify-between gap-3">
        <span className="text-[15px] text-fg">{field.label}</span>
        <Switch checked={checked} onChange={(next) => onChange(next)} aria-label={field.label} />
      </div>
    );
  }

  if (field.kind === "select") {
    return (
      <fieldset>
        <legend className="mb-2 text-sm font-semibold text-fg">{field.label}</legend>
        <div className="grid grid-cols-2 gap-2">
          {(field.options ?? []).map((o, i) => <label key={o.value} className={cn("flex min-h-12 cursor-pointer items-center gap-2 rounded-xl border px-3 py-2 text-sm font-medium transition", value === o.value ? "border-accent bg-accent-soft text-accent-text" : "border-line bg-sunken text-fg hover:border-accent")}><input className="accent-accent" type="radio" name={field.key} value={o.value} checked={value === o.value} required={field.required} autoFocus={autoFocus && i === 0} onChange={() => onChange(o.value)} /><span>{o.label}</span></label>)}
        </div>
      </fieldset>
    );
  }

  if (field.kind === "textarea") {
    return (
      <Field label={field.label}>
        <Textarea
          required={field.required}
          autoFocus={autoFocus}
          placeholder={field.placeholder}
          value={(value as string) ?? ""}
          onChange={(e) => onChange(e.target.value)}
        />
      </Field>
    );
  }

  if (field.kind === "file") {
    return (
      <Field label={field.label} hint={field.accept ? `Accepted file types: ${field.accept}${field.multiple ? ". You can choose more than one." : "."}` : field.multiple ? "Images only. You can choose more than one." : "Images only."}>
        <input
          type="file"
          required={field.required}
          autoFocus={autoFocus}
          multiple={field.multiple}
          accept={field.accept ?? "image/png,image/jpeg,image/webp,image/gif"}
          onChange={(e) => onFiles(Array.from(e.target.files ?? []))}
          className={cn(
            "w-full rounded-[var(--radius-sm)] border border-dashed border-line-strong bg-sunken px-3 py-2.5 text-[14px] text-fg-2",
            "file:me-3 file:h-9 file:cursor-pointer file:rounded-[var(--radius-sm)] file:border-0 file:bg-accent file:px-3.5 file:text-[13.5px] file:font-semibold file:text-accent-fg hover:file:bg-accent-hover",
          )}
        />
      </Field>
    );
  }

  if (field.kind === "keywords") {
    return <KeywordsField label={field.label} placeholder={field.placeholder} autoFocus={autoFocus} value={(value as string[] | undefined) ?? []} onChange={onChange} />;
  }


  return (
    <Field label={field.label}>
      <Input
        required={field.required}
        autoFocus={autoFocus}
        autoComplete="off"
        placeholder={field.placeholder}
        value={(value as string) ?? ""}
        onChange={(e) => onChange(e.target.value)}
      />
    </Field>
  );
}

/** Free-text keyword entry. Keeps the raw text locally — deriving the input's
 * value from the parsed array (as it did) deleted every comma/space the
 * moment it was typed, so "hi, hello" was saved as one keyword "hihello". */
function KeywordsField({
  label,
  placeholder,
  autoFocus,
  value,
  onChange,
}: {
  label: string;
  placeholder?: string;
  autoFocus?: boolean;
  value: string[];
  onChange: (next: string[]) => void;
}) {
  const [raw, setRaw] = useState(() => value.join(", "));
  return (
    <Field label={label} hint="Separate with commas or spaces">
      <Input
        autoFocus={autoFocus}
        autoComplete="off"
        placeholder={placeholder}
        value={raw}
        onChange={(e) => {
          setRaw(e.target.value);
          onChange(
            e.target.value
              .split(/[,\s]+/)
              .map((s) => s.trim())
              .filter(Boolean),
          );
        }}
      />
    </Field>
  );
}
