import { BadRequestException, Injectable } from "@nestjs/common";
import {
  BotAction,
  BotActionResult,
  BotHandler,
  BotMenuItem,
  BotMenuScreen,
} from "../bot.interface";
import { PacksService, PackSummaryView } from "src/packs/packs.service";
import { PackType } from "src/enum/base.enum";

/** "1 pack" / "3 packs" — user-facing copy shouldn't read "pack(s)". */
function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function packType(value: unknown): PackType {
  return value === PackType.EMOJI ? PackType.EMOJI : PackType.STICKER;
}

function str(params: Record<string, unknown>, key: string): string {
  const value = params[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new BadRequestException(`"${key}" is required`);
  }
  return value.trim();
}

function optStr(
  params: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = params[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function optBool(
  params: Record<string, unknown>,
  key: string,
): boolean | undefined {
  const value = params[key];
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  return undefined;
}

/** Accepts a bare slug or a full share link/deep-link and returns just the slug. */
function extractSlug(input: string): string {
  const trimmed = input.trim();
  const lastSegment = trimmed.split(/[/?#]/).filter(Boolean).pop();
  return (lastSegment ?? trimmed).trim();
}

/**
 * The first bot on the new framework (`../bot.interface.ts`) — view/create/edit/remove your own
 * sticker & animated-emoji packs, and add/remove packs from your collection, entirely through
 * generic menu screens (no `/commands`, see the framework's own doc comment for why). Every
 * screen here is just `PacksService` calls shaped into a `BotMenuScreen` — no new business logic
 * lives in this file, which is the point: a bot is a *view* over an existing service, not a
 * parallel API.
 */
@Injectable()
export class PackManagerBot implements BotHandler {
  readonly key = "pack-manager";
  readonly name = "Pack Manager";
  readonly description =
    "Create and manage your sticker packs and animated-emoji packs.";

  constructor(private readonly packsService: PacksService) {}

  async getScreen(
    screenId: string,
    userId: string,
    params: Record<string, unknown>,
  ): Promise<BotMenuScreen> {
    switch (screenId) {
      case "home":
        return this.homeScreen(userId);
      case "my-packs":
        return this.myPacksScreen(userId, packType(params.type));
      case "pack-detail":
        return this.packDetailScreen(userId, str(params, "packId"));
      default:
        return this.homeScreen(userId);
    }
  }

  async invokeAction(
    actionId: string,
    screenId: string,
    userId: string,
    params: Record<string, unknown>,
    files: Express.Multer.File[],
  ): Promise<BotActionResult> {
    switch (actionId) {
      case "create-pack": {
        const pack = await this.packsService.create(
          {
            type: packType(params.type),
            name: str(params, "name"),
            description: optStr(params, "description"),
            isPublic: optBool(params, "isPublic"),
          },
          userId,
        );
        return {
          screen: {
            ...(await this.packDetailScreen(userId, pack.id)),
            toast: "Pack created — add some items to it.",
          },
        };
      }

      case "add-by-link": {
        const slug = extractSlug(str(params, "slugOrLink"));
        const pack = await this.packsService.findBySlug(slug, userId);
        return {
          screen: {
            ...(await this.packDetailScreen(userId, pack.id)),
            toast: pack.isSubscribed
              ? "You already have this pack."
              : "Pack found — tap Add to save it to your collection.",
          },
        };
      }

      case "add-items": {
        const packId = str(params, "packId");
        const keywords = Array.isArray(params.keywords)
          ? (params.keywords as unknown[]).map(String)
          : optStr(params, "keywords")
              ?.split(/[,\s]+/)
              .filter(Boolean);
        await this.packsService.addItems(packId, files, keywords, userId);
        return {
          screen: {
            ...(await this.packDetailScreen(userId, packId)),
            toast: `${plural(files.length, "item")} added.`,
          },
        };
      }

      case "edit-pack": {
        const packId = str(params, "packId");
        await this.packsService.updatePack(
          packId,
          {
            name: optStr(params, "name"),
            description: optStr(params, "description"),
            isPublic: optBool(params, "isPublic"),
          },
          userId,
        );
        return {
          screen: {
            ...(await this.packDetailScreen(userId, packId)),
            toast: "Pack updated.",
          },
        };
      }

      case "copy-link": {
        const packId = str(params, "packId");
        const pack = await this.packsService.findOne(packId, userId);
        return {
          screen: {
            ...(await this.packDetailScreen(userId, packId)),
            toast: `Invite link copied: /packs/${pack.slug}`,
          },
        };
      }

      case "delete-pack": {
        const packId = str(params, "packId");
        const pack = await this.packsService.findOne(packId, userId);
        await this.packsService.deletePack(packId, userId);
        return {
          screen: {
            ...(await this.myPacksScreen(userId, pack.type)),
            toast: "Pack deleted.",
          },
        };
      }

      case "subscribe": {
        const packId = str(params, "packId");
        await this.packsService.subscribe(packId, userId);
        return {
          screen: {
            ...(await this.packDetailScreen(userId, packId)),
            toast: "Added to your packs.",
          },
        };
      }

      case "unsubscribe": {
        const packId = str(params, "packId");
        await this.packsService.unsubscribe(packId, userId);
        return {
          screen: {
            ...(await this.packDetailScreen(userId, packId)),
            toast: "Removed from your packs.",
          },
        };
      }

      case "remove-item": {
        const packId = str(params, "packId");
        const itemId = str(params, "itemId");
        await this.packsService.removeItem(packId, itemId, userId);
        return {
          screen: {
            ...(await this.packDetailScreen(userId, packId)),
            toast: "Item removed.",
          },
        };
      }

      default:
        return { screen: await this.homeScreen(userId) };
    }
  }

  private createPackAction(presetType?: PackType): BotAction {
    return {
      id: "create-pack",
      label: "Create a pack",
      type: "form",
      style: "primary",
      params: presetType ? { type: presetType } : undefined,
      fields: [
        { key: "name", label: "Pack name", kind: "text", required: true },
        { key: "description", label: "Description", kind: "textarea" },
        presetType
          ? {
              key: "type",
              label: "Type",
              kind: "select",
              required: true,
              options: [
                {
                  label:
                    presetType === PackType.EMOJI
                      ? "Animated emoji"
                      : "Stickers",
                  value: presetType,
                },
              ],
            }
          : {
              key: "type",
              label: "Type",
              kind: "select",
              required: true,
              options: [
                { label: "Stickers", value: PackType.STICKER },
                { label: "Animated emoji", value: PackType.EMOJI },
              ],
            },
        {
          key: "isPublic",
          label: "Discoverable in pack search",
          kind: "toggle",
        },
      ],
    };
  }

  private addByLinkAction(): BotAction {
    return {
      id: "add-by-link",
      label: "Add a pack by link",
      type: "form",
      fields: [
        {
          key: "slugOrLink",
          label: "Invite link or code",
          kind: "text",
          required: true,
          placeholder: "e.g. party-cats or a full share link",
        },
      ],
    };
  }

  private async homeScreen(userId: string): Promise<BotMenuScreen> {
    const [stickerPacks, emojiPacks] = await Promise.all([
      this.packsService.listMine(userId, PackType.STICKER),
      this.packsService.listMine(userId, PackType.EMOJI),
    ]);
    const items: BotMenuItem[] = [
      {
        id: "sticker-packs",
        title: "My Sticker Packs",
        subtitle: plural(stickerPacks.length, "pack"),
        action: {
          id: "open-sticker-packs",
          label: "Open",
          type: "navigate",
          screenId: "my-packs",
          params: { type: PackType.STICKER },
        },
      },
      {
        id: "emoji-packs",
        title: "My Animated Emoji Packs",
        subtitle: plural(emojiPacks.length, "pack"),
        action: {
          id: "open-emoji-packs",
          label: "Open",
          type: "navigate",
          screenId: "my-packs",
          params: { type: PackType.EMOJI },
        },
      },
    ];
    return {
      screenId: "home",
      title: "Pack Manager",
      subtitle: "Create and manage your sticker & animated-emoji packs",
      items,
      actions: [this.createPackAction(), this.addByLinkAction()],
    };
  }

  private async myPacksScreen(
    userId: string,
    type: PackType,
  ): Promise<BotMenuScreen> {
    const packs = await this.packsService.listMine(userId, type);
    return {
      screenId: "my-packs",
      title:
        type === PackType.EMOJI
          ? "My Animated Emoji Packs"
          : "My Sticker Packs",
      items: packs.map(p => this.packRow(p)),
      actions: [this.createPackAction(type), this.addByLinkAction()],
    };
  }

  private packRow(pack: PackSummaryView): BotMenuItem {
    return {
      id: pack.id,
      title: pack.name,
      subtitle: `${plural(pack.itemCount, "item")}${pack.isOwner ? " · owned by you" : ""}`,
      action: {
        id: "open-pack",
        label: "Open",
        type: "navigate",
        screenId: "pack-detail",
        params: { packId: pack.id },
      },
    };
  }

  private async packDetailScreen(
    userId: string,
    packId: string,
  ): Promise<BotMenuScreen> {
    const pack = await this.packsService.findOne(packId, userId);
    const items: BotMenuItem[] = pack.items.map(item => ({
      id: item.id,
      title: item.keywords.length ? item.keywords.join(" ") : "(no keywords)",
      subtitle: `used ${item.usageCount}×`,
      imageUrl: item.relativePath,
      action: pack.isOwner
        ? {
            id: "remove-item",
            label: "Remove",
            type: "invoke",
            style: "destructive",
            confirmText: "Remove this item from the pack?",
            params: { packId: pack.id, itemId: item.id },
          }
        : {
            id: "noop",
            label: "",
            type: "navigate",
            screenId: "pack-detail",
            params: { packId: pack.id },
          },
    }));

    const actions: BotAction[] = pack.isOwner
      ? [
          {
            id: "add-items",
            label: "Add items",
            type: "form",
            style: "primary",
            params: { packId: pack.id },
            fields: [
              {
                key: "files",
                label:
                  "Images — PNG, JPEG, WebP or GIF (animated WebP and GIF stay animated)",
                kind: "file",
                required: true,
                multiple: true,
              },
              {
                key: "keywords",
                label: "Search keywords (applies to all uploaded)",
                kind: "keywords",
              },
            ],
          },
          {
            id: "edit-pack",
            label: "Edit pack details",
            type: "form",
            params: { packId: pack.id },
            fields: [
              { key: "name", label: "Pack name", kind: "text" },
              { key: "description", label: "Description", kind: "textarea" },
              {
                key: "isPublic",
                label: "Discoverable in pack search",
                kind: "toggle",
              },
            ],
          },
          {
            id: "copy-link",
            label: "Copy invite link",
            type: "invoke",
            params: { packId: pack.id },
          },
          {
            id: "delete-pack",
            label: "Delete pack",
            type: "invoke",
            style: "destructive",
            confirmText: "Delete this pack? This can't be undone.",
            params: { packId: pack.id },
          },
        ]
      : [
          pack.isSubscribed
            ? {
                id: "unsubscribe",
                label: "Remove from my packs",
                type: "invoke",
                style: "destructive",
                params: { packId: pack.id },
              }
            : {
                id: "subscribe",
                label: "Add to my packs",
                type: "invoke",
                style: "primary",
                params: { packId: pack.id },
              },
        ];

    return {
      screenId: "pack-detail",
      title: pack.name,
      subtitle:
        `${plural(pack.itemCount, "item")} · ${pack.isPublic ? "Public" : "Private"} · ` +
        `/packs/${pack.slug}`,
      items,
      actions,
    };
  }
}
