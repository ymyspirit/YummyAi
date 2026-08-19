import { Permission } from "@yummyai/authz";
import { createEntityId, type TenantContext } from "@yummyai/contracts";
import {
  assetFiles,
  auditEvents,
  connectDatabase,
  migrateDatabase,
  withTenant,
} from "@yummyai/database";
import { createStorageFromEnvironment, isSignedUrlExpired } from "@yummyai/storage";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AuditService } from "../audit/audit.service.js";
import type { AuthenticatedRequest } from "../auth/tenant-context.guard.js";
import { AssetsController } from "./assets.controller.js";

describe("private assets", () => {
  const database = connectDatabase();
  const storage = createStorageFromEnvironment();
  const audit = new AuditService(database);
  const controller = new AssetsController(storage, database, audit);
  const tenantId = createEntityId();
  const userId = createEntityId();
  const otherTenantId = createEntityId();
  const context: TenantContext = {
    tenantId,
    userId,
    permissions: [Permission.AssetRead, Permission.AssetWrite],
    dataScope: "tenant",
  };
  const otherContext: TenantContext = {
    tenantId: otherTenantId,
    userId: createEntityId(),
    permissions: [Permission.AssetRead],
    dataScope: "tenant",
  };
  const request: AuthenticatedRequest = { headers: {}, tenantContext: context };
  let assetId: string;
  let assetObjectKey: string;

  beforeAll(async () => {
    await migrateDatabase(database);
    await storage.ensureBucket();
    await database.client.unsafe(
      `insert into organizations (id, name, slug) values ($1, 'Asset tenant', $2), ($3, 'Other tenant', $4)`,
      [tenantId, `asset-${tenantId}`, otherTenantId, `other-${otherTenantId}`],
    );
    await database.client.unsafe(
      `insert into app_users (id, oidc_subject, email, display_name) values ($1, $2, $3, 'Asset User')`,
      [userId, `asset-${userId}`, `${userId}@example.test`],
    );
  });

  afterAll(async () => {
    await database.client.end();
  });

  it("uploads a private research asset and records an audit event", async () => {
    const result = await controller.upload(request, {
      dataBase64: Buffer.from("same-content").toString("base64"),
      domain: "research",
      fileName: "sample.png",
      mediaType: "image/png",
      traceId: "trace-upload",
    });
    assetId = result.id;
    assetObjectKey = result.objectKey;

    expect(result.objectKey).toContain(`tenants/${tenantId}/research/`);
    expect(result.deduplicated).toBe(false);
    const events = await withTenant(database.db, context, (tx) =>
      tx.select().from(auditEvents).where(eq(auditEvents.entityId, result.id)),
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ action: "asset.upload", result: "success", traceId: "trace-upload" });
  });

  it("deduplicates the same checksum and object key", async () => {
    const result = await controller.upload(request, {
      dataBase64: Buffer.from("same-content").toString("base64"),
      domain: "research",
      fileName: "sample.png",
      mediaType: "image/png",
    });

    expect(result.id).toBe(assetId);
    expect(result.deduplicated).toBe(true);
    const files = await withTenant(database.db, context, (tx) => tx.select().from(assetFiles));
    expect(files).toHaveLength(1);
  });

  it("does not sign a research object as authorized", async () => {
    await expect(
      controller.signRead(request, assetId, { requiredDomain: "authorized" }),
    ).rejects.toThrow();
  });

  it("creates a ten-minute private read URL", async () => {
    const result = await controller.signRead(request, assetId, { requiredDomain: "research" });
    const url = new URL(result.url);
    expect(url.searchParams.get("X-Amz-Expires")).toBe("600");
    expect(isSignedUrlExpired(result.url)).toBe(false);
    const response = await fetch(result.url);
    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe("same-content");
  });

  it("denies unsigned object access", async () => {
    const endpoint = process.env.S3_ENDPOINT ?? "http://localhost:9000";
    const bucket = process.env.S3_PRIVATE_BUCKET ?? "yummyai-private";
    const response = await fetch(`${endpoint}/${bucket}/${assetObjectKey}`);
    expect(response.status).toBe(403);
  });

  it("does not reveal an asset across tenants", async () => {
    const otherRequest: AuthenticatedRequest = { headers: {}, tenantContext: otherContext };
    await expect(
      controller.signRead(otherRequest, assetId, { requiredDomain: "research" }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("redacts sensitive audit metadata recursively", async () => {
    const auditId = await audit.record(context, {
      action: "credential.test",
      resourceType: "system",
      result: "success",
      metadata: { nested: { apiKey: "should-not-persist" }, token: "secret" },
    });
    const [event] = await withTenant(database.db, context, (tx) =>
      tx.select().from(auditEvents).where(eq(auditEvents.id, auditId)),
    );
    expect(event.metadata).toEqual({ nested: { apiKey: "[REDACTED]" }, token: "[REDACTED]" });
  });

  it("keeps audit events append-only for the application role", async () => {
    await expect(
      withTenant(database.db, context, (tx) =>
        tx.update(auditEvents).set({ action: "tampered" }).where(eq(auditEvents.tenantId, tenantId)),
      ),
    ).rejects.toThrow();
  });
});
