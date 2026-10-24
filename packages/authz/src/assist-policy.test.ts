import { createEntityId, type TenantContext } from "@yummyai/contracts";
import { CreateAssistSchema, type CreateAssist } from "@yummyai/contracts/ai/assist";
import { describe, expect, it } from "vitest";
import { authorizeAssistRequest, requiredAssistPermissions } from "./assist-policy.js";
import { ForbiddenError } from "./authorize.js";
import { Permission } from "./permissions.js";

const context: TenantContext = { tenantId: createEntityId(), userId: createEntityId(), dataScope: "tenant", permissions: Object.values(Permission) };
const template: CreateAssist = { kind: "template_config", inspectionId: createEntityId(), requestId: createEntityId(), modelId: createEntityId() };
const without = (permission: Permission): TenantContext => ({ ...context, permissions: context.permissions.filter(value => value !== permission) });

describe("shared AI assist admission policy", () => {
  it("requires both design read and write for execution but permits read-only history", () => {
    expect(() => authorizeAssistRequest(without(Permission.DesignWrite), template, "read")).not.toThrow();
    expect(() => authorizeAssistRequest(without(Permission.DesignWrite), template, "run")).toThrow(ForbiddenError);
    expect(() => authorizeAssistRequest(without(Permission.DesignRead), template, "run")).toThrow(ForbiddenError);
    expect(requiredAssistPermissions("artwork_preflight", "run")).toContain(Permission.DesignRead);
  });

  it("does not grant knowledge access because a task has another business kind", () => {
    expect(() => authorizeAssistRequest(without(Permission.WorkflowRead), template, "run")).not.toThrow();
    expect(() => authorizeAssistRequest(without(Permission.WorkflowRead), template, "run", { hasKnowledge: true })).toThrow(ForbiddenError);
  });

  it("checks product context, scoped account evidence and evaluation independently", () => {
    const request = CreateAssistSchema.parse({ requestId: createEntityId(), modelId: createEntityId(), kind: "knowledge_answer", scopeId: createEntityId(),
      search: { query: "synthetic guidance", topic: "all", platform: "amazon", market: "US", spuIds: [createEntityId()] }, purpose: "evaluation", evidenceStoreId: createEntityId() });
    for (const permission of [Permission.WorkflowRead, Permission.WorkflowRun, Permission.WorkflowManage, Permission.ProductRead, Permission.FinanceRead, Permission.StoreRead])
      expect(() => authorizeAssistRequest(without(permission), request, "run")).toThrow(ForbiddenError);
    expect(() => authorizeAssistRequest(context, request, "run")).not.toThrow();
    expect(() => authorizeAssistRequest(without(Permission.WorkflowManage), request, "read")).not.toThrow();
  });

  it("cannot use an earlier tenant-wide snapshot after the current scope is reduced", () => {
    expect(() => authorizeAssistRequest({ ...context, dataScope: "self" }, template, "run", { pinnedDataScope: "tenant" })).toThrow(ForbiddenError);
    expect(() => authorizeAssistRequest(context, template, "run", { pinnedDataScope: "self" })).not.toThrow();
  });

  it("does not allow callers to supply their own execution policy through task requests", () => {
    expect(() => CreateAssistSchema.parse({ ...template, accessPolicy: { version: "forged", requiredPermissions: [] } })).toThrow();
  });
});
