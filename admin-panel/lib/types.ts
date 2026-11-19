export type AdminRole = "superadmin" | "support" | "moderator";

export interface AdminMe {
  adminId: string;
  email: string;
  role: AdminRole;
}

export type UserStatus = "active" | "suspended" | "deleted";

export interface UserRow {
  id: string;
  username: string;
  firstName: string;
  lastName: string;
  email: string;
  phoneNumber: string;
  avatar: string | null;
  status: UserStatus;
  suspendedUntil: string | null;
  createdAt: string;
  lastSeen: string | null;
}

export interface UserDetail {
  profile: UserRow & { bio: string };
  memberships: Array<{
    chatId: string;
    name: string;
    type: string;
    role: string;
    isBanned: boolean;
    mutedByAdmin: boolean;
    isChatLocked: boolean;
    isChatDeleted: boolean;
  }>;
  sessions: Array<{
    id: string;
    device: string | null;
    ip: string | null;
    lastUsedAt: string;
    revokedAt: string | null;
    createdAt: string;
  }>;
  reports: Array<{
    id: string;
    role: "reporter" | "target";
    targetType: string;
    targetId: string;
    reason: string;
    status: string;
    action: string | null;
    createdAt: string;
  }>;
  history: AuditEntry[];
}

export interface AuditEntry {
  id: string;
  actor: { id: string; email: string; role: string } | null;
  action: string;
  targetType: string;
  targetId: string;
  meta: Record<string, unknown> | null;
  at: string;
}

export interface Paged<T> {
  items: T[];
  total: number;
}
