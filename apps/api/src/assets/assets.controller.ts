import { Body, Controller, Inject, NotFoundException, Param, Post, Req } from "@nestjs/common";
import { Permission, authorize } from "@yummyai/authz";
import { createEntityId, type TenantContext } from "@yummyai/contracts";
import { and, eq } from "drizzle-orm";
import { assetFiles, type DatabaseConnection, withTenant } from "@yummyai/database";
import type { AssetDomain, Storage } from "@yummyai/storage";

import { AuditService } from "../audit/audit.service.js";
import { RequiresPermission } from "../auth/permissions.decorator.js";
import type { AuthenticatedRequest } from "../auth/tenant-context.guard.js";
import { DATABASE_CONNECTION, PRIVATE_STORAGE } from "../platform.tokens.js";

interface UploadAssetBody {
  dataBase64: string;
  domain: AssetDomain;
  fileName: string;
  mediaType: string;
  traceId?: string;
}

interface SignAssetBody {
  requiredDomain: AssetDomain;
  traceId?: string;
}

@Controller("assets")
export class AssetsController {
  constructor(
    @Inject(PRIVATE_STORAGE) private readonly storage: Storage,
    @Inject(DATABASE_CONNECTION) private readonly database: DatabaseConnection,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  @Post()
  @RequiresPermission(Permission.AssetWrite)
  async upload(@Req() request: AuthenticatedRequest, @Body() body: UploadAssetBody) {
    const context = requireContext(request);
    authorize(context, Permission.AssetWrite);
    if (!body.fileName || !body.mediaType || !["research", "authorized"].includes(body.domain)) {
      throw new Error("A valid file name, media type, and asset domain are required");
    }
    const content = Uint8Array.from(Buffer.from(body.dataBase64, "base64"));
    if (!content.byteLength) throw new Error("The uploaded asset is empty");

    const stored = await this.storage.putPrivate(context, {
      body: content,
      domain: body.domain,
      fileName: body.fileName,
      mediaType: body.mediaType,
    });

    const file = await withTenant(this.database.db, context, async (tx) => {
      const [existing] = await tx
        .select()
        .from(assetFiles)
        .where(and(eq(assetFiles.tenantId, context.tenantId), eq(assetFiles.objectKey, stored.objectKey)))
        .limit(1);
      if (existing) return existing;

      const [created] = await tx
        .insert(assetFiles)
        .values({
          id: createEntityId(),
          tenantId: context.tenantId,
          ownerUserId: context.userId,
          objectKey: stored.objectKey,
          assetDomain: body.domain,
          fileName: body.fileName,
          mediaType: body.mediaType,
          byteSize: content.byteLength,
          checksumSha256: stored.checksumSha256,
        })
        .returning();
      return created;
    });

    await this.audit.record(context, {
      action: "asset.upload",
      resourceType: "asset_file",
      resourceId: file.id,
      result: "success",
      traceId: body.traceId,
      metadata: { domain: body.domain, deduplicated: stored.deduplicated, fileName: body.fileName },
    });
    return { ...file, deduplicated: stored.deduplicated };
  }

  @Post(":id/read-url")
  @RequiresPermission(Permission.AssetRead)
  async signRead(
    @Req() request: AuthenticatedRequest,
    @Param("id") id: string,
    @Body() body: SignAssetBody,
  ) {
    const context = requireContext(request);
    authorize(context, Permission.AssetRead);
    const [file] = await withTenant(this.database.db, context, (tx) =>
      tx.select().from(assetFiles).where(eq(assetFiles.id, id)).limit(1),
    );
    if (!file) throw new NotFoundException("Asset not found");

    const url = await this.storage.signRead(
      context,
      {
        id: file.id,
        tenantId: file.tenantId,
        assetDomain: file.assetDomain as AssetDomain,
        objectKey: file.objectKey,
      },
      { requiredDomain: body.requiredDomain },
    );
    await this.audit.record(context, {
      action: "asset.read_url.create",
      resourceType: "asset_file",
      resourceId: file.id,
      result: "success",
      traceId: body.traceId,
      metadata: { requiredDomain: body.requiredDomain },
    });
    return { url, expiresInSeconds: 600 };
  }
}

function requireContext(request: AuthenticatedRequest): TenantContext {
  if (!request.tenantContext) throw new Error("Tenant context is required");
  return request.tenantContext;
}
