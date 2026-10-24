import { describe, expect, it } from "vitest";
import { createEntityId } from "../common/ids.js";
import { CreativeExecutionAuthoritySchema, CreativeExecutionCompletionSchema, CreativeExecutionKindSchema } from "./execution.js";

describe("creative execution contracts", () => {
  const tenantId = createEntityId(), userId = createEntityId();
  const context = { tenantId, userId, permissions: ["design:read"], dataScope: "self" };
  it("distinguishes original membership ceilings from explicit server adapter ceilings", () => {
    expect(CreativeExecutionAuthoritySchema.parse({ version: "creative-authority-v1", mode: "server_adapter", context }).context.userId).toBe(userId);
    expect(CreativeExecutionAuthoritySchema.safeParse({ version: "creative-authority-v1", mode: "membership", context }).success).toBe(false);
    expect(CreativeExecutionAuthoritySchema.parse({ version: "creative-authority-v1", mode: "membership", context: { ...context, permissionScopes: { "design:read": "self" } } }).context.permissionScopes).toEqual({ "design:read": "self" });
    expect(CreativeExecutionAuthoritySchema.parse({ version: "creative-authority-v1", mode: "server_adapter", context: { ...context, permissionScopes: { "design:read": "self" } } }).mode).toBe("server_adapter");
  });
  it("rejects unrecognized fields and malformed authority instead of storing credentials", () => {
    for (const patch of [{ token: "synthetic-value" }, { permissionScopes: { "design:read": "global" } }, { permissions: [] }])
      expect(CreativeExecutionAuthoritySchema.safeParse({ version: "creative-authority-v1", mode: "server_adapter", context: { ...context, ...patch } }).success).toBe(false);
    expect(CreativeExecutionAuthoritySchema.safeParse({ version: "creative-authority-v1", mode: "server_adapter", context, executionTool: "unregistered" }).success).toBe(false);
  });
  it("names actual owner kinds and requires original input and artifact identities for completion", () => {
    expect(CreativeExecutionKindSchema.options).toHaveLength(5);
    const record = { version: "creative-completion-v1", executionId: createEntityId(), inputFingerprint: "a".repeat(64), responseChecksum: "b".repeat(64), artifacts: [{ assetId: createEntityId(), version: 1, checksumSha256: "c".repeat(64) }], ownerResultChecksum: "d".repeat(64) };
    expect(CreativeExecutionCompletionSchema.parse(record).artifacts).toHaveLength(1);
    expect(CreativeExecutionCompletionSchema.safeParse({ ...record, inputFingerprint: "unknown" }).success).toBe(false);
    expect(CreativeExecutionCompletionSchema.safeParse({ ...record, artifacts: [{ ...record.artifacts[0], version: 0 }] }).success).toBe(false);
  });
});
