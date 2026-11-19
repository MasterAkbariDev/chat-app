import { ChatType, UserRole } from "src/enum/base.enum";
import { effectivePermissions, permissionForMessageType } from "./permissions";

describe("effectivePermissions", () => {
  const group = {
    type: ChatType.GROUP,
    defaultPermissions: { sendStickers: false },
  };
  const channel = { type: ChatType.CHANNEL };

  it("gives the owner everything", () => {
    const p = effectivePermissions(group, { role: UserRole.OWNER });
    expect(p.admin.addAdmins).toBe(true);
    expect(p.member.sendStickers).toBe(true);
    expect(p.canDeleteChat).toBe(true);
  });

  it("applies the group defaults to members, and per-person exceptions on top", () => {
    expect(
      effectivePermissions(group, { role: UserRole.MEMBER }).member
        .sendStickers,
    ).toBe(false);
    const vip = effectivePermissions(group, {
      role: UserRole.MEMBER,
      permissions: { sendStickers: true, pinMessages: true },
    });
    expect(vip.member.sendStickers).toBe(true);
    expect(vip.member.pinMessages).toBe(true);
  });

  it("blocks every kind of send when sending is off (incl. the legacy mute flag)", () => {
    const muted = effectivePermissions(group, {
      role: UserRole.MEMBER,
      mutedByAdmin: true,
    });
    expect(muted.canPost).toBe(false);
    expect(muted.member.sendMedia).toBe(false);
    expect(muted.member.sendVoice).toBe(false);
  });

  it("uses the admin's own rights (default: all but adding admins)", () => {
    const a = effectivePermissions(group, { role: UserRole.ADMIN });
    expect(a.admin.deleteMessages).toBe(true);
    expect(a.admin.addAdmins).toBe(false);
    const limited = effectivePermissions(group, {
      role: UserRole.ADMIN,
      adminRights: { pinMessages: false },
    });
    expect(limited.member.pinMessages).toBe(false);
  });

  it("lets only posting admins write in a channel", () => {
    expect(
      effectivePermissions(channel, { role: UserRole.MEMBER }).canPost,
    ).toBe(false);
    expect(
      effectivePermissions(channel, {
        role: UserRole.ADMIN,
        adminRights: { postMessages: false },
      }).canPost,
    ).toBe(false);
    expect(
      effectivePermissions(channel, { role: UserRole.ADMIN }).canPost,
    ).toBe(true);
  });

  it("gives nothing to someone who left or was banned", () => {
    expect(
      effectivePermissions(group, { role: UserRole.ADMIN, isJoined: false })
        .role,
    ).toBeNull();
    expect(
      effectivePermissions(group, { role: UserRole.MEMBER, isBanned: true })
        .canPost,
    ).toBe(false);
  });

  it("maps message types to the right permission", () => {
    expect(permissionForMessageType("sticker")).toBe("sendStickers");
    expect(permissionForMessageType("video_note")).toBe("sendVoice");
    expect(permissionForMessageType("image")).toBe("sendMedia");
    expect(permissionForMessageType(undefined)).toBe("sendMessages");
  });
});
