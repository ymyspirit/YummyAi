import { Body, Controller, Get, Inject, NotFoundException, Param, Patch, Post, Req } from "@nestjs/common";
import type { SecretVault } from "@yummyai/ai-core";
import { Permission, authorize } from "@yummyai/authz";
import { createEntityId, type TenantContext } from "@yummyai/contracts";
import { modelProviderConfigs, type DatabaseConnection, withTenant } from "@yummyai/database";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { RequiresPermission } from "../auth/permissions.decorator.js";
import type { AuthenticatedRequest } from "../auth/tenant-context.guard.js";
import { DATABASE_CONNECTION, MODEL_SECRET_VAULT } from "../platform.tokens.js";

const ProviderSchema = z.enum(["openai", "anthropic", "openai-compatible"]);
const StatusSchema = z.enum(["enabled", "disabled"]);
const EndpointSchema = z.url().refine((value) => value.startsWith("https://") || isLocalEndpoint(value), {
  message: "Provider endpoint must use HTTPS unless it targets localhost",
});

const CreateProviderConfigSchema = z.object({
  provider: ProviderSchema,
  label: z.string().trim().min(1).max(80),
  endpoint: EndpointSchema.nullish(),
  apiKey: z.string().min(1).max(8_192),
  status: StatusSchema.default("enabled"),
}).superRefine((value, context) => {
  if (value.provider === "openai-compatible" && !value.endpoint) {
    context.addIssue({ code: "custom", path: ["endpoint"], message: "OpenAI-compatible providers require an endpoint" });
  }
});

const UpdateProviderConfigSchema = z.object({
  label: z.string().trim().min(1).max(80).optional(),
  endpoint: EndpointSchema.nullable().optional(),
  apiKey: z.string().min(1).max(8_192).optional(),
  status: StatusSchema.optional(),
}).refine((value) => Object.keys(value).length > 0, "At least one field is required");

@Controller("v1/ai/model-configs")
export class ModelConfigController {
  constructor(
    @Inject(DATABASE_CONNECTION) private readonly database: DatabaseConnection,
    @Inject(MODEL_SECRET_VAULT) private readonly secrets: SecretVault,
  ) {}

  @Get()
  @RequiresPermission(Permission.ModelConfigure)
  async list(@Req() request: AuthenticatedRequest) {
    const context = requireContext(request);
    authorize(context, Permission.ModelConfigure);
    const rows = await withTenant(this.database.db, context, (tx) =>
      tx
        .select({
          id: modelProviderConfigs.id,
          provider: modelProviderConfigs.provider,
          label: modelProviderConfigs.label,
          endpoint: modelProviderConfigs.endpoint,
          status: modelProviderConfigs.status,
          createdAt: modelProviderConfigs.createdAt,
          updatedAt: modelProviderConfigs.updatedAt,
        })
        .from(modelProviderConfigs)
        .orderBy(modelProviderConfigs.createdAt),
    );
    return rows.map((row) => ({ ...row, hasCredential: true }));
  }

  @Post()
  @RequiresPermission(Permission.ModelConfigure)
  async create(@Req() request: AuthenticatedRequest, @Body() body: unknown) {
    const context = requireContext(request);
    authorize(context, Permission.ModelConfigure);
    const input = CreateProviderConfigSchema.parse(body);
    const [created] = await withTenant(this.database.db, context, (tx) =>
      tx
        .insert(modelProviderConfigs)
        .values({
          id: createEntityId(),
          tenantId: context.tenantId,
          provider: input.provider,
          label: input.label,
          endpoint: input.endpoint ?? null,
          encryptedApiKey: this.secrets.encrypt(input.apiKey),
          status: input.status,
          createdBy: context.userId,
        })
        .returning(publicSelection),
    );
    return { ...created, hasCredential: true };
  }

  @Patch(":id")
  @RequiresPermission(Permission.ModelConfigure)
  async update(@Req() request: AuthenticatedRequest, @Param("id") id: string, @Body() body: unknown) {
    const context = requireContext(request);
    authorize(context, Permission.ModelConfigure);
    const configId = z.uuidv7().parse(id);
    const input = UpdateProviderConfigSchema.parse(body);
    const [updated] = await withTenant(this.database.db, context, (tx) =>
      tx
        .update(modelProviderConfigs)
        .set({
          ...(input.label === undefined ? {} : { label: input.label }),
          ...(input.endpoint === undefined ? {} : { endpoint: input.endpoint }),
          ...(input.status === undefined ? {} : { status: input.status }),
          ...(input.apiKey === undefined ? {} : { encryptedApiKey: this.secrets.encrypt(input.apiKey) }),
          updatedAt: new Date(),
        })
        .where(and(eq(modelProviderConfigs.tenantId, context.tenantId), eq(modelProviderConfigs.id, configId)))
        .returning(publicSelection),
    );
    if (!updated) throw new NotFoundException("Model provider configuration not found");
    return { ...updated, hasCredential: true };
  }
}

const publicSelection = {
  id: modelProviderConfigs.id,
  provider: modelProviderConfigs.provider,
  label: modelProviderConfigs.label,
  endpoint: modelProviderConfigs.endpoint,
  status: modelProviderConfigs.status,
  createdAt: modelProviderConfigs.createdAt,
  updatedAt: modelProviderConfigs.updatedAt,
};

function requireContext(request: AuthenticatedRequest): TenantContext {
  if (!request.tenantContext) throw new Error("Tenant context is required");
  return request.tenantContext;
}

function isLocalEndpoint(value: string): boolean {
  try {
    const hostname = new URL(value).hostname;
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
  } catch {
    return false;
  }
}
