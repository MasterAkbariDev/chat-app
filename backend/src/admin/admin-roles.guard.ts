import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { ADMIN_ROLES_KEY } from "./admin-roles.decorator";
import { AdminRole } from "./schema/admin-user.schema";

/**
 * Least privilege (ADMIN_PANEL_PLAN cross-cutting): a route with `@AdminRoles(...)` is refused
 * for any admin whose role is not listed. A route with no `@AdminRoles` is open to every admin.
 */
@Injectable()
export class AdminRolesGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<AdminRole[] | undefined>(
      ADMIN_ROLES_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!required || required.length === 0) {
      return true;
    }
    const { user } = context.switchToHttp().getRequest<{
      user?: { role?: string };
    }>();
    if (!user?.role || !required.includes(user.role as AdminRole)) {
      throw new ForbiddenException("Your admin role cannot do this");
    }
    return true;
  }
}
