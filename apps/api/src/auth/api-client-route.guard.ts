import { type CanActivate, type ExecutionContext, ForbiddenException, Inject, Injectable, SetMetadata } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { permissionScope, type PermissionValue } from "@yummyai/authz";
import { IntegrationApiScopeSchema } from "@yummyai/contracts";
import { AgentReadCallSchema } from "@yummyai/contracts/ai/agent-read";
import { Permission } from "@yummyai/authz";
import { REQUIRED_PERMISSIONS } from "./permissions.decorator.js";
import type { AuthenticatedRequest } from "./tenant-context.guard.js";

export const API_CLIENT_METADATA_READ = "yummyai:api-client-metadata-read";
export const ApiClientMetadataRead = () => SetMetadata(API_CLIENT_METADATA_READ, true);
export const API_CLIENT_VERIFIED_READ_TOOLS = "yummyai:api-client-verified-read-tools-v1";
/** Only the fixed, schema-pinned owner readers may use a POST transport. */
export const ApiClientVerifiedReadTools = () => SetMetadata(API_CLIENT_VERIFIED_READ_TOOLS, true);

/** Legacy owners have not all proved self/team object filtering. Keep their
 * original tenant-only read boundary until each narrower adapter is verified. */
@Injectable()
export class ApiClientRouteGuard implements CanActivate {
  constructor(@Inject(Reflector) private readonly reflector: Reflector) {}
  canActivate(execution: ExecutionContext): boolean {
    const request = execution.switchToHttp().getRequest<AuthenticatedRequest & { method?: string; body?: unknown }>();
    if (request.authenticationKind !== "api_client") return true;
    const targets = [execution.getHandler(), execution.getClass()];
    const metadataOnly = this.reflector.getAllAndOverride<boolean>(API_CLIENT_METADATA_READ, targets);
    if (request.method === "GET" && metadataOnly === true) return true;
    const required = this.reflector.getAllAndOverride<PermissionValue[]>(REQUIRED_PERMISSIONS, targets);
    const current = request.tenantContext;
    if (request.method === "POST" && current && this.reflector.getAllAndOverride<boolean>(API_CLIENT_VERIFIED_READ_TOOLS, targets) === true) {
      const call = AgentReadCallSchema.safeParse(request.body);
      const bit = call.success ? call.data.tool === "orders.exceptions.page" ? Permission.OrderRead : Permission.InventoryRead : null;
      if (bit && current.permissions.includes(bit) && permissionScope(current, bit) === "tenant") return true;
    }
    if (request.method === "GET" && current && required?.length && required.every(bit =>
      IntegrationApiScopeSchema.options.some(scope => scope === bit) && current.permissions.includes(bit) && permissionScope(current, bit) === "tenant")) return true;
    throw new ForbiddenException({ code: "api_client_owner_scope_not_verified",
      message: "This API client route requires a verified owner adapter and its permitted data scope" });
  }
}
