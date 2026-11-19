import { SetMetadata } from "@nestjs/common";
import { AdminRole } from "./schema/admin-user.schema";

export const ADMIN_ROLES_KEY = "adminRoles";

/**
 * Restricts a route to the listed admin roles. Must be used together with `AdminJwtAuthGuard`
 * (it reads `req.user.role` that the admin-jwt strategy sets) — and on its own it does nothing.
 */
export const AdminRoles = (...roles: AdminRole[]) =>
  SetMetadata(ADMIN_ROLES_KEY, roles);
