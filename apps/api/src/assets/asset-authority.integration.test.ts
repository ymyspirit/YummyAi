import { Permission } from "@yummyai/authz";
import { createEntityId, type TenantContext } from "@yummyai/contracts";
import {
  assetFiles,
  connectDatabase,
  loadCurrentMembershipContext,
  migrateDatabase,
  roles,
  withTenant,
} from "@yummyai/database";
import { createStorageFromEnvironment } from "@yummyai/storage";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { AuditService } from "../audit/audit.service.js";
import type { AuthenticatedRequest } from "../auth/tenant-context.guard.js";
import { AssetsController } from "./assets.controller.js";

if (
  process.env.E2E_ISOLATED_DAILY !== "1" ||
  !/^\/order_daily_e2e_[a-f0-9]{32}$/.test(new URL(process.env.DATABASE_URL!).pathname) ||
  !/^order-daily-e2e-[a-f0-9]{32}$/.test(process.env.S3_PRIVATE_BUCKET ?? "")
)
  throw new Error("Run asset authority through the disposable order-daily acceptance runner");

describe("asset authority with real membership, RLS and private storage", () => {
  const database = connectDatabase();
  const storage = createStorageFromEnvironment();
  const audit = new AuditService(database);
  const controller = new AssetsController(storage, database, audit);
  const tenantId = createEntityId(), userId = createEntityId(), otherUser = createEntityId();
  const membershipId = createEntityId(), roleId = createEntityId(), extraRoleId = createEntityId();
  const permissions = [Permission.AssetRead, Permission.AssetWrite, Permission.OrderRead, Permission.OrderPiiRead];
  const base: TenantContext = { tenantId, userId, permissions, dataScope: "tenant" };
  const request = (context: TenantContext): AuthenticatedRequest => ({ headers: {}, tenantContext: context });
  const upload = (text: string, fileName = `${text}.txt`) => ({
    dataBase64: Buffer.from(text).toString("base64"), domain: "authorized" as const,
    fileName, mediaType: "text/plain",
  });
  let ownId: string, otherId: string, orderId: string;

  async function grant(values: readonly string[] = permissions, scope: "self" | "team" | "tenant" = "tenant") {
    await withTenant(database.db, base, tx => tx.update(roles).set({ permissions: values, dataScope: scope }).where(eq(roles.id, roleId)));
  }
  async function extra(values: readonly string[] = [Permission.WorkflowRead], scope: "self" | "team" | "tenant" = "tenant") {
    await withTenant(database.db, base, tx => tx.update(roles).set({ permissions: values, dataScope: scope }).where(eq(roles.id, extraRoleId)));
  }
  const current = () => withTenant(database.db, base, tx => loadCurrentMembershipContext(tx, base));
  const file = (id: string) => withTenant(database.db, base, async tx =>
    (await tx.select().from(assetFiles).where(eq(assetFiles.id, id)))[0]);

  beforeAll(async () => {
    await migrateDatabase(database);
    await storage.ensureBucket();
    await database.client.unsafe("insert into organizations(id,name,slug) values($1,'Asset authority',$2)", [tenantId, `asset-authority-${tenantId}`]);
    for (const id of [userId, otherUser])
      await database.client.unsafe("insert into app_users(id,oidc_subject,email,display_name) values($1,$2,$3,'Synthetic asset operator')", [id, `asset-${id}`, `${id}@example.test`]);
    await database.client.unsafe("insert into memberships(id,tenant_id,user_id,status) values($1,$2,$3,'active')", [membershipId, tenantId, userId]);
    for (const [id, name, values] of [[roleId, "Asset role", permissions], [extraRoleId, "Unrelated wide role", [Permission.WorkflowRead]]] as const) {
      await database.client.unsafe("insert into roles(id,tenant_id,name,permissions,data_scope) values($1,$2,$3,$4::jsonb,'tenant')", [id, tenantId, name, JSON.stringify(values)]);
      await database.client.unsafe("insert into membership_roles(tenant_id,membership_id,role_id) values($1,$2,$3)", [tenantId, membershipId, id]);
    }
    ownId = (await controller.upload(request(base), upload("own-fixture"))).id;
    otherId = (await controller.upload(request({ ...base, userId: otherUser }), upload("other-fixture"))).id;
    const order = await storage.putPrivate(base, { body: Buffer.from("synthetic-private-order"), domain: "order", fileName: "private-order.txt", mediaType: "text/plain" });
    orderId = createEntityId();
    await withTenant(database.db, base, tx => tx.insert(assetFiles).values({
      id: orderId, tenantId, ownerUserId: userId, objectKey: order.objectKey,
      assetDomain: "order", fileName: "private-order.txt", mediaType: "text/plain",
      byteSize: Buffer.byteLength("synthetic-private-order"), checksumSha256: order.checksumSha256,
    }));
  });
  beforeEach(async () => { vi.restoreAllMocks(); await grant(); await extra(); });
  afterAll(async () => {
    vi.restoreAllMocks();
    // The guarded runner removes the entire disposable database, bucket and Redis,
    // including unreferenced objects from an interrupted upload and immutable audits.
    await database.client.end();
  });

  it.each(["self", "team"] as const)("does not borrow an unrelated tenant scope for %s asset reads", async scope => {
    await grant([Permission.AssetRead], scope);
    const context = await current();
    expect(context.dataScope).toBe("tenant");
    const signer = vi.spyOn(storage, "signRead");
    await expect(controller.signRead(request(context), otherId, { requiredDomain: "authorized" })).rejects.toMatchObject({ status: 403 });
    expect(signer).not.toHaveBeenCalled();
    const own = await controller.signRead(request(context), ownId, { requiredDomain: "authorized" });
    expect(await (await fetch(own.url)).text()).toBe("own-fixture");
  });

  it("rejects a revoked original reader before private signing", async () => {
    const context = await current(); await grant([]);
    const signer = vi.spyOn(storage, "signRead");
    await expect(controller.signRead(request(context), ownId, { requiredDomain: "authorized" })).rejects.toMatchObject({ status: 403 });
    expect(signer).not.toHaveBeenCalled();
  });

  it("does not return a URL when membership is revoked during signing", async () => {
    const context = await current(), original = storage.signRead.bind(storage);
    vi.spyOn(storage, "signRead").mockImplementationOnce(async (...args) => {
      const url = await original(...args); await grant([]); return url;
    });
    await expect(controller.signRead(request(context), ownId, { requiredDomain: "authorized" })).rejects.toMatchObject({ status: 403 });
  });

  it("rechecks permission after the signing audit before returning private metadata", async () => {
    const context = await current(), original = audit.record.bind(audit);
    vi.spyOn(audit, "record").mockImplementationOnce(async (...args) => {
      const id = await original(...args); await grant([]); return id;
    });
    await expect(controller.signRead(request(context), ownId, { requiredDomain: "authorized" })).rejects.toMatchObject({ status: 403 });
  });

  it("requires current order and PII permissions even for the uploader's order asset", async () => {
    await grant([Permission.AssetRead]);
    const signer = vi.spyOn(storage, "signRead");
    await expect(controller.signRead(request(await current()), orderId, { requiredDomain: "order" })).rejects.toMatchObject({ status: 403 });
    expect(signer).not.toHaveBeenCalled();
  });

  it.each([Permission.OrderRead, Permission.OrderPiiRead])("checks %s scope independently of the asset scope", async permission => {
    const other = permission === Permission.OrderRead ? Permission.OrderPiiRead : Permission.OrderRead;
    await grant([Permission.AssetRead, other]); await extra([permission], "self");
    const signer = vi.spyOn(storage, "signRead");
    await expect(controller.signRead(request(await current()), orderId, { requiredDomain: "order" })).rejects.toMatchObject({ status: 403 });
    expect(signer).not.toHaveBeenCalled();
  });

  it("allows authorized tenant order reads with the existing ten-minute URL contract", async () => {
    const result = await controller.signRead(request(await current()), orderId, { requiredDomain: "order" });
    expect(new URL(result.url).searchParams.get("X-Amz-Expires")).toBe("600");
    expect(await (await fetch(result.url)).text()).toBe("synthetic-private-order");
  });

  it("rejects a revoked uploader before creating a private object", async () => {
    const context = await current(); await grant([]);
    const writer = vi.spyOn(storage, "putPrivate");
    await expect(controller.upload(request(context), upload("revoked-before-put"))).rejects.toMatchObject({ status: 403 });
    expect(writer).not.toHaveBeenCalled();
  });

  it("does not associate an uploaded object after in-flight revocation", async () => {
    const context = await current(), original = storage.putPrivate.bind(storage);
    const writer = vi.spyOn(storage, "putPrivate").mockImplementationOnce(async (...args) => {
      const result = await original(...args); await grant([]); return result;
    });
    await expect(controller.upload(request(context), upload("revoked-after-put"))).rejects.toMatchObject({ status: 403 });
    expect(writer).toHaveBeenCalledTimes(1);
    const rows = await withTenant(database.db, base, tx => tx.select().from(assetFiles).where(eq(assetFiles.fileName, "revoked-after-put.txt")));
    expect(rows).toHaveLength(0);
  });

  it("does not return an upload receipt after revocation without pretending the committed file rolled back", async () => {
    const context = await current(), original = audit.record.bind(audit);
    vi.spyOn(audit, "record").mockImplementationOnce(async (...args) => {
      const id = await original(...args); await grant([]); return id;
    });
    await expect(controller.upload(request(context), upload("revoked-after-commit"))).rejects.toMatchObject({ status: 403 });
    const rows = await withTenant(database.db, base, tx => tx.select().from(assetFiles).where(eq(assetFiles.fileName, "revoked-after-commit.txt")));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ ownerUserId: userId, rightsStatus: "unverified" });
  });

  it("does not turn deduplication into access to another owner's asset", async () => {
    await grant([Permission.AssetWrite], "self");
    await expect(controller.upload(request(await current()), upload("other-fixture"))).rejects.toMatchObject({ status: 403 });
    expect((await file(otherId))?.ownerUserId).toBe(otherUser);
  });

  it("retains self-owned creation and idempotent upload without widening the original request", async () => {
    await grant([Permission.AssetRead, Permission.AssetWrite], "self");
    const context = await current();
    await grant(permissions);
    const first = await controller.upload(request(context), upload("self-owned-new"));
    const second = await controller.upload(request(context), upload("self-owned-new"));
    expect(first.ownerUserId).toBe(userId); expect(second.id).toBe(first.id);
    await expect(controller.signRead(request(context), otherId, { requiredDomain: "authorized" })).rejects.toMatchObject({ status: 403 });
  });

  it("does not issue new read URLs for a soft-deleted file", async () => {
    const created = await controller.upload(request(base), upload("retired-fixture"));
    await withTenant(database.db, base, tx => tx.update(assetFiles).set({ deletedAt: new Date() }).where(eq(assetFiles.id, created.id)));
    const signer = vi.spyOn(storage, "signRead");
    await expect(controller.signRead(request(await current()), created.id, { requiredDomain: "authorized" })).rejects.toMatchObject({ status: 404 });
    expect(signer).not.toHaveBeenCalled();
    await expect(controller.upload(request(await current()), upload("retired-fixture"))).rejects.toMatchObject({ status: 409 });
    expect((await file(created.id))?.deletedAt).not.toBeNull();
  });
});
