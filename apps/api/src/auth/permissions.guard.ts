import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { authorize, ForbiddenError, type PermissionValue } from "@yummyai/authz";

import { REQUIRED_PERMISSIONS } from "./permissions.decorator.js";
import type { AuthenticatedRequest } from "./tenant-context.guard.js";

@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(@Inject(Reflector) private readonly reflector: Reflector) {}

  canActivate(executionContext: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<PermissionValue[]>(REQUIRED_PERMISSIONS, [
      executionContext.getHandler(),
      executionContext.getClass(),
    ]);

    if (!required?.length) return true;

    const request = executionContext.switchToHttp().getRequest<AuthenticatedRequest>();
    if (!request.tenantContext) throw new ForbiddenException("Tenant context is unavailable");

    try {
      for (const permission of required) authorize(request.tenantContext, permission);
      return true;
    } catch (error) {
      if (error instanceof ForbiddenError) {
        throw new ForbiddenException({
          code: error.code,
          permission: error.permission,
          reason: error.reason,
        });
      }
      throw error;
    }
  }
}
