import { Body, Controller, Get, Inject, Param, Patch, Post, Req } from "@nestjs/common";
import { Permission, authorize } from "@yummyai/authz";
import { CreateIntegrationApiClientInputSchema, CreateWebhookEndpointInputSchema, PublishWebhookEventInputSchema, ReplayWebhookDeliveryInputSchema, RevokeIntegrationApiClientInputSchema, RotateWebhookSecretInputSchema, RunIntegrationRetentionInputSchema, UpdateWebhookEndpointInputSchema } from "@yummyai/contracts/integration";
import { z } from "zod";

import { RequiresPermission } from "../auth/permissions.decorator.js";
import type { AuthenticatedRequest } from "../auth/tenant-context.guard.js";
import { IntegrationService } from "./integration.service.js";

@Controller("v1/integrations")
export class IntegrationController {
  constructor(@Inject(IntegrationService) private readonly service: IntegrationService) {}
  @Get("workspace") @RequiresPermission(Permission.IntegrationRead) workspace(@Req() request: AuthenticatedRequest) { const context = requireContext(request); authorize(context, Permission.IntegrationRead); return this.service.workspace(context); }
  @Post("api-clients") @RequiresPermission(Permission.IntegrationManage) createClient(@Req() request: AuthenticatedRequest, @Body() body: unknown) { const context = requireContext(request); authorize(context, Permission.IntegrationManage); return this.service.createApiClient(context, CreateIntegrationApiClientInputSchema.parse(body)); }
  @Post("api-clients/:clientId/revoke") @RequiresPermission(Permission.IntegrationManage) revokeClient(@Req() request: AuthenticatedRequest, @Param("clientId") clientId: string, @Body() body: unknown) { const context = requireContext(request); authorize(context, Permission.IntegrationManage); return this.service.revokeApiClient(context, z.uuidv7().parse(clientId), RevokeIntegrationApiClientInputSchema.parse(body)); }
  @Post("webhook-endpoints") @RequiresPermission(Permission.IntegrationManage) createEndpoint(@Req() request: AuthenticatedRequest, @Body() body: unknown) { const context = requireContext(request); authorize(context, Permission.IntegrationManage); return this.service.createWebhookEndpoint(context, CreateWebhookEndpointInputSchema.parse(body)); }
  @Patch("webhook-endpoints/:endpointId") @RequiresPermission(Permission.IntegrationManage) updateEndpoint(@Req() request: AuthenticatedRequest, @Param("endpointId") endpointId: string, @Body() body: unknown) { const context = requireContext(request); authorize(context, Permission.IntegrationManage); return this.service.updateWebhookEndpoint(context, z.uuidv7().parse(endpointId), UpdateWebhookEndpointInputSchema.parse(body)); }
  @Post("webhook-endpoints/:endpointId/rotate-secret") @RequiresPermission(Permission.IntegrationManage) rotateEndpointSecret(@Req() request: AuthenticatedRequest, @Param("endpointId") endpointId: string, @Body() body: unknown) { const context = requireContext(request); authorize(context, Permission.IntegrationManage); return this.service.rotateWebhookSecret(context, z.uuidv7().parse(endpointId), RotateWebhookSecretInputSchema.parse(body)); }
  @Post("webhook-events") @RequiresPermission(Permission.IntegrationManage) publishEvent(@Req() request: AuthenticatedRequest, @Body() body: unknown) { const context = requireContext(request); authorize(context, Permission.IntegrationManage); return this.service.publishEvent(context, PublishWebhookEventInputSchema.parse(body)); }
  @Post("webhook-deliveries/:deliveryId/replay") @RequiresPermission(Permission.IntegrationManage) replayDelivery(@Req() request: AuthenticatedRequest, @Param("deliveryId") deliveryId: string, @Body() body: unknown) { const context = requireContext(request); authorize(context, Permission.IntegrationManage); return this.service.replayDelivery(context, z.uuidv7().parse(deliveryId), ReplayWebhookDeliveryInputSchema.parse(body)); }
  @Post("retention-runs") @RequiresPermission(Permission.IntegrationManage) runRetention(@Req() request: AuthenticatedRequest, @Body() body: unknown) { const context = requireContext(request); authorize(context, Permission.IntegrationManage); return this.service.runRetention(context, RunIntegrationRetentionInputSchema.parse(body)); }
}
function requireContext(request: AuthenticatedRequest) { if (!request.tenantContext) throw new Error("Tenant context is required"); return request.tenantContext; }
