import { SecretVault } from "@yummyai/ai-core";
import { ForbiddenError, Permission } from "@yummyai/authz";
import { createEntityId, type TenantContext } from "@yummyai/contracts";
import type { DatabaseConnection } from "@yummyai/database";
import { describe, expect, it, vi } from "vitest";
import { AmazonReportArchiveProcessor } from "./amazon-report-processing.js";

describe("Amazon attachment permission ceiling", () => {
  it.each([
    [Permission.OrderWrite, "self"], [Permission.OrderWrite, "team"],
    [Permission.OrderPiiRead, "self"], [Permission.OrderPiiRead, "team"],
  ] as const)("rejects %s narrowed to %s despite an unrelated tenant grant", async (permission, scope) => {
    const transaction = vi.fn();
    const database = { db: { transaction } } as unknown as DatabaseConnection;
    const vault = new SecretVault(Buffer.alloc(32, 103));
    const decrypt = vi.spyOn(vault, "withSecret");
    const gateway = { download: vi.fn(), scan: vi.fn() };
    const context: TenantContext = {
      tenantId: createEntityId(), userId: createEntityId(), dataScope: "tenant",
      permissions: [Permission.OrderWrite, Permission.OrderPiiRead, Permission.NotificationRead],
      permissionScopes: { [Permission.OrderWrite]: "tenant", [Permission.OrderPiiRead]: "tenant", [Permission.NotificationRead]: "tenant", [permission]: scope },
    };
    await expect(new AmazonReportArchiveProcessor(database, vault, gateway)
      .process(context, createEntityId(), null, undefined, createEntityId())).rejects.toBeInstanceOf(ForbiddenError);
    expect(transaction).not.toHaveBeenCalled();
    expect(decrypt).not.toHaveBeenCalled();
    expect(gateway.download).not.toHaveBeenCalled();
    expect(gateway.scan).not.toHaveBeenCalled();
  });
});
