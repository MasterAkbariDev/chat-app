/**
 * The bot framework's screen and action contract. A bot is a small,
 * server-driven **menu tree**: the server describes one screen (a title, some rows, some
 * buttons) as data; the client renders it generically from that data and POSTs back whichever
 * action the person tapped. No bot-specific frontend code is needed beyond a generic
 * screen-renderer plus, optionally, a custom row-renderer for content that benefits from one
 * (e.g. a pack row showing a thumbnail strip) — everything else (forms, confirms, navigation)
 * is generic. Adding bot #2 means implementing this one interface, nothing else.
 */

export type BotActionType = "navigate" | "invoke" | "form";

export type BotFormFieldKind =
  "text" | "textarea" | "toggle" | "select" | "file" | "keywords";

export interface BotFormField {
  key: string;
  label: string;
  kind: BotFormFieldKind;
  required?: boolean;
  placeholder?: string;
  /** For `kind: "select"`. */
  options?: { label: string; value: string }[];
  /** For `kind: "file"` — allow selecting more than one. */
  multiple?: boolean;
  /** Allowed file types for file fields, using the HTML accept syntax. */
  accept?: string;
}

export interface BotAction {
  id: string;
  label: string;
  type: BotActionType;
  style?: "default" | "primary" | "destructive";
  /** `type: "navigate"` — which screen to request next (no server-side effect). */
  screenId?: string;
  /** `type: "form"` — what to render/collect before invoking. */
  fields?: BotFormField[];
  /** Shown as a client-side confirmation prompt before an `"invoke"`/`"form"` action fires. */
  confirmText?: string;
  /**
   * Context the action already knows (e.g. `{packId}` for a row's own "Remove" button) — opaque
   * to the client, which echoes it back verbatim in the `POST .../action` body, merged with any
   * form field values the person typed.
   */
  params?: Record<string, unknown>;
}

export interface BotMenuItem {
  id: string;
  title: string;
  subtitle?: string;
  imageUrl?: string;
  badge?: string;
  /** Tapping the row performs this action — usually `"navigate"` into a detail screen. */
  action: BotAction;
}

export interface BotMenuScreen {
  screenId: string;
  title: string;
  subtitle?: string;
  /** Optional conversational presentation, shared by any bot. */
  presentation?: "conversation";
  items: BotMenuItem[];
  /** Page-level buttons, not tied to one row (e.g. "Create pack"). */
  actions: BotAction[];
  /** One-off message the client should surface (e.g. "Pack created") after landing here. */
  toast?: string;
}

export interface BotActionResult {
  /** What to render next — the same screen refreshed, or a different one entirely. */
  screen: BotMenuScreen;
}

export interface BotSummary {
  key: string;
  name: string;
  description: string;
  avatarUrl?: string;
}

export interface BotHandler extends BotSummary {
  /** A deployment-defined permission; unscoped bots remain available to all signed-in users. */
  accessScope?: string;
  /** `screenId` defaults to `"home"` when a client first opens the bot. */
  getScreen(
    screenId: string,
    userId: string,
    params: Record<string, unknown>,
  ): Promise<BotMenuScreen>;

  invokeAction(
    actionId: string,
    screenId: string,
    userId: string,
    params: Record<string, unknown>,
    files: Express.Multer.File[],
  ): Promise<BotActionResult>;
}

export const BOT_HANDLERS = Symbol("BOT_HANDLERS");
