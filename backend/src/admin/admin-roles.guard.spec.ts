import { ExecutionContext, ForbiddenException } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { AdminRolesGuard } from "./admin-roles.guard";
import { AdminRole } from "./schema/admin-user.schema";

const contextFor = (role: string | undefined): ExecutionContext =>
  ({
    getHandler: () => undefined,
    getClass: () => undefined,
    switchToHttp: () => ({
      getRequest: () => ({ user: role === undefined ? undefined : { role } }),
    }),
  }) as unknown as ExecutionContext;

describe("AdminRolesGuard (least privilege per route)", () => {
  const guardRequiring = (roles: AdminRole[] | undefined) => {
    const reflector = new Reflector();
    jest.spyOn(reflector, "getAllAndOverride").mockReturnValue(roles);
    return new AdminRolesGuard(reflector);
  };

  it("allows every admin on a route with no @AdminRoles", () => {
    const guard = guardRequiring(undefined);
    expect(guard.canActivate(contextFor(AdminRole.MODERATOR))).toBe(true);
  });

  it("allows an admin whose role is listed", () => {
    const guard = guardRequiring([AdminRole.SUPERADMIN]);
    expect(guard.canActivate(contextFor(AdminRole.SUPERADMIN))).toBe(true);
  });

  it("refuses an admin whose role is not listed", () => {
    const guard = guardRequiring([AdminRole.SUPERADMIN]);
    expect(() => guard.canActivate(contextFor(AdminRole.SUPPORT))).toThrow(
      ForbiddenException,
    );
  });

  it("refuses when there is no admin role on the request at all", () => {
    const guard = guardRequiring([AdminRole.SUPERADMIN]);
    expect(() => guard.canActivate(contextFor(undefined))).toThrow(
      ForbiddenException,
    );
  });
});
