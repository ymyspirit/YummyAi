import { beforeEach, describe, expect, it, vi } from "vitest";
import { HarnessContractError, SecretVault, harnessChecksum } from "@yummyai/ai-core";
import { Permission, intersectPermissionContexts } from "@yummyai/authz";
import { createEntityId, TenantContextSchema, type TenantContext } from "@yummyai/contracts";
import { erpSessionAuthority } from "@yummyai/contracts/auth/session";
import { erpPermissionContext } from "@yummyai/authz";
import { AGENT_READ_VERSION, AgentReadCallSchema, AgentReadPageViewSchema } from "@yummyai/contracts/ai/agent-read";
import { AgentPlanCommandKeySchema } from "@yummyai/contracts/ai/agent-plan";
import { AGENT_TOOLS_VERSION, agentToolInputSchemas, type AgentToolInput, type AgentToolKey } from "@yummyai/contracts/ai/agent-tools";
import { CreativeExecutionHistorySchema } from "@yummyai/contracts/harness/creative-operator";
import { FactoryCapacityWorkspaceSchema } from "@yummyai/contracts/suppliers/factory-capacity";
import { agentReadHarness } from "./agent-read-gateway.js";
import { SharedAgentToolsGateway, agentToolsHarness, agentToolsSkill } from "./agent-tools-gateway.js";
import type { AgentToolCommandsPort, AgentToolOwnerPort } from "./agent-tools-ports.js";

const time = "2026-10-22T00:00:00.000Z", hash = "a".repeat(64);
const context = TenantContextSchema.parse({ tenantId: createEntityId(), userId: createEntityId(), permissions: Object.values(Permission), dataScope: "tenant",
  permissionScopes: Object.fromEntries(Object.values(Permission).map(bit => [bit, "tenant"])), teamIds: [] });
const stamp = (value: TenantContext) => erpSessionAuthority(erpPermissionContext(value));
const query = { query: "Synthetic approved knowledge", topic: "all", platform: "all", market: "ALL", spuIds: [] };
const commands: AgentToolCommandsPort = () => AgentPlanCommandKeySchema.options.flatMap(option => option.shape.kind.options.map(kind => ({
  domain: option.shape.domain.value, kind, label: "Original " + kind, effect: "prepare_original_command", preparation: "registered_original_owner",
  execution: "exact_operator_confirmation", externalEffect: option.shape.domain.value === "production" ? "original_production_release" : "internal_record_only",
  available: option.shape.domain.value === "procurement" && kind === "requisition_create",
  blockReason: option.shape.domain.value === "procurement" && kind === "requisition_create" ? null : "native_owner_not_admitted_in_pure_fixture" })));

function fixture() {
  let live = context;
  const ports = {
    legacyRead: vi.fn(async (current: TenantContext, raw: Parameters<AgentToolOwnerPort["legacyRead"]>[1]) => {
      const call = AgentReadCallSchema.parse(raw);
      return AgentReadPageViewSchema.parse({ version: AGENT_READ_VERSION, effect: "read", tool: call.tool, contextAuthority: stamp(current),
        checkedAt: time, collectionFingerprint: hash, total: 0, readCount: 0, consistency: "unchanged_collection", complete: true, nextCursor: null, query: call.input, items: [] });
    }),
    knowledgeSearch: vi.fn(async () => ({
      references: [], diagnostics: ["Synthetic bounded native retrieval"], retrievedAt: time, mode: "keyword" as const, scanned: 9 })),
    creativeHistory: vi.fn(async (_current: TenantContext, input: AgentToolInput<"creative.history">) => CreativeExecutionHistorySchema.parse({
      scope: input.scope, ownerId: input.ownerId, entries: [], nextCursor: null })),
    factoryCapacity: vi.fn(async (current: TenantContext, input: AgentToolInput<"factory.capacity">) => FactoryCapacityWorkspaceSchema.parse({
      contextAuthority: stamp(current), access: { canRead: true, canWrite: true }, factoryId: input.factoryId, from: input.query.from ?? "2026-10-22",
      days: input.query.days, recordedAt: time, pools: [], calendar: [] })),
  } satisfies AgentToolOwnerPort;
  // No connection is constructed: the explicit fifth argument owns pure-test authority.
  const gateway = new SharedAgentToolsGateway(null!, new SecretVault(Buffer.alloc(32, 59)), ports, commands,
    async caller => intersectPermissionContexts(caller, live));
  const call = async (tool: AgentToolKey, input: unknown, caller = context) => {
    const workspace = await gateway.workspace(caller), definition = await gateway.definition(caller, { version: AGENT_TOOLS_VERSION, selection: { kind: "read", tool } });
    return { version: AGENT_TOOLS_VERSION, executionContract: workspace.executionContract, definitionChecksum: definition.definitionChecksum, tool, input };
  };
  return { gateway, ports, call, setLive(value: TenantContext) { live = value; } };
}

describe("native Agent tools gateway protocol without paid or business executors", () => {
  let f: ReturnType<typeof fixture>;
  beforeEach(() => { f = fixture(); });

  it("discovers metadata and exactly one selected native schema without dispatching any owner or exposing the37-branch plan union", async () => {
    const workspace = await f.gateway.workspace(context);
    expect(workspace).toMatchObject({ modelExecution: "not_connected_to_legacy_loops", mcpState: "not_connected" });
    expect(workspace.tools).toHaveLength(5); expect(workspace.commands).toHaveLength(37);
    expect(agentToolsHarness.descriptor(workspace.executionContract, agentToolsSkill, "knowledge.search").timeout.mode).toBe("result_deadline");
    const definition = await f.gateway.definition(context, { version: AGENT_TOOLS_VERSION, selection: { kind: "command", command: { domain: "procurement", kind: "requisition_create" } } });
    expect(definition).toMatchObject({ effect: "prepare_original_command", execution: "separate_original_preparation_and_confirmation", available: true });
    const wire = JSON.stringify(definition.inputSchema); expect(wire).toContain("requisition_create");
    for (const unselected of ["payment_record", "purchase_review", "reviewed_order", "observation_record"]) expect(wire.includes(unselected)).toBe(false);
    const repeat = await f.gateway.definition(context, { version: AGENT_TOOLS_VERSION, selection: definition.selection });
    expect(repeat.definitionChecksum).toBe(definition.definitionChecksum);
    for (const port of Object.values(f.ports)) expect(port).not.toHaveBeenCalled();
  });

  it("dispatches each of the five exact native readers and adapts the two legacy readers to their original strict version and pin", async () => {
    const requests: Array<[AgentToolKey, unknown]> = [["orders.exceptions.page", { pageSize: 1, cursor: null, status: "open" }],
      ["inventory.balances.page", { pageSize: 1, cursor: null }], ["knowledge.search", query],
      ["creative.history", { scope: "inspection", ownerId: createEntityId() }], ["factory.capacity", { factoryId: createEntityId(), query: { from: "2026-10-22", days: 2 } }]];
    const results = [];
    for (const [tool, input] of requests) {
      const result = await f.gateway.call(context, await f.call(tool, input));
      expect(result.tool).toBe(tool); expect(result.dataChecksum).toBe(harnessChecksum(result.data)); expect(result.contextAuthority).toBe(stamp(context)); results.push(result);
      expect(result.inputChecksum).toBe(harnessChecksum(agentToolInputSchemas[tool].parse(input)));
    }
    expect(results.map(result => result.coverage.kind)).toEqual(["paged_collection", "paged_collection", "ranked_subset", "bounded_history", "bounded_snapshot"]);
    expect(results.slice(2).every(result => result.coverage.complete === false)).toBe(true);
    const oldPin = agentReadHarness.pin({ key: "erp.agent.read", version: AGENT_READ_VERSION });
    for (const [, original] of f.ports.legacyRead.mock.calls) {
      expect(Object.keys(original).sort()).toEqual(["executionContract", "input", "tool", "version"]);
      expect(original.version).toBe(AGENT_READ_VERSION); expect(original.executionContract).toEqual(oldPin);
      expect(AgentReadCallSchema.safeParse(original).success).toBe(true);
    }
    expect(f.ports.legacyRead).toHaveBeenCalledTimes(2); expect(f.ports.knowledgeSearch).toHaveBeenCalledTimes(1);
    expect(f.ports.creativeHistory).toHaveBeenCalledTimes(1); expect(f.ports.factoryCapacity).toHaveBeenCalledTimes(1);
    const otherQuery = await f.gateway.call(context, await f.call("knowledge.search", { ...query, query: "Different original query with the same bounded result" }));
    expect(otherQuery.dataChecksum).toBe(results[2]!.dataChecksum); expect(otherQuery.inputChecksum).not.toBe(results[2]!.inputChecksum);
  });

  it("rejects mismatched native objects and malformed native results instead of relabelling their origin or coverage", async () => {
    const ownerId = createEntityId();
    f.ports.creativeHistory.mockResolvedValueOnce({ scope: "inspection", ownerId: createEntityId(), entries: [], nextCursor: null });
    await expect(f.gateway.call(context, await f.call("creative.history", { scope: "inspection", ownerId }))).rejects.toMatchObject({ statusCode: 502, code: "agent_tool_owner_mismatch" });
    const factoryId = createEntityId(), other = FactoryCapacityWorkspaceSchema.parse({ contextAuthority: stamp(context), access: { canRead: true, canWrite: true },
      factoryId: createEntityId(), from: "2026-10-22", days: 2, recordedAt: time, pools: [], calendar: [] });
    f.ports.factoryCapacity.mockResolvedValueOnce(other);
    await expect(f.gateway.call(context, await f.call("factory.capacity", { factoryId, query: { from: "2026-10-22", days: 2 } }))).rejects.toMatchObject({ statusCode: 502, code: "agent_tool_owner_mismatch" });
    f.ports.knowledgeSearch.mockResolvedValueOnce({ references: [], diagnostics: [], retrievedAt: "invalid-native-timestamp", mode: "keyword", scanned: 9 });
    await expect(f.gateway.call(context, await f.call("knowledge.search", query))).rejects.toBeInstanceOf(HarnessContractError);
  });

  it("rejects altered definitions pins dynamic writes caller identities and narrow-domain reads before any native dispatch", async () => {
    const original = await f.call("knowledge.search", query);
    for (const invalid of [{ ...original, definitionChecksum: "f".repeat(64) }, { ...original, executionContract: { ...original.executionContract, checksum: "f".repeat(64) } },
      { ...original, tool: "finance.payment.execute" }, { ...original, tenantId: createEntityId() }, { ...original, input: { ...query, url: "https://synthetic.invalid" } }])
      await expect(f.gateway.call(context, invalid)).rejects.toMatchObject({ statusCode: expect.any(Number) });
    const scopes = { ...context.permissionScopes, "inventory:read": "self" as const };
    const narrow = { ...context, permissionScopes: scopes };
    const unavailable = await f.gateway.definition(narrow, { version: AGENT_TOOLS_VERSION, selection: { kind: "read", tool: "inventory.balances.page" } });
    expect(unavailable.available).toBe(false);
    await expect(f.gateway.call(narrow, await f.call("inventory.balances.page", { pageSize: 1, cursor: null }, narrow))).rejects.toMatchObject({ statusCode: 403 });
    for (const port of Object.values(f.ports)) expect(port).not.toHaveBeenCalled();
  });

  it("discards a late completed owner response after current authority changes and never widens a caller permission ceiling", async () => {
    let entered!: () => void, release!: () => void;
    const arrived = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
    f.ports.knowledgeSearch.mockImplementationOnce(async () => { entered(); await gate; return { references: [], diagnostics: [], retrievedAt: time, mode: "keyword", scanned: 0 }; });
    const call = await f.call("knowledge.search", query), pending = f.gateway.call(context, call);
    try {
      await arrived;
      f.setLive({ ...context, permissionScopes: { ...context.permissionScopes, "workflow:read": "self" } });
      release(); await expect(pending).rejects.toMatchObject({ statusCode: 409, code: "authority_changed" });
    } finally { release(); }
    const caller = { ...context, permissionScopes: { ...context.permissionScopes, "inventory:read": "self" as const } };
    f.setLive(context);
    expect((await f.gateway.workspace(caller)).tools.find(tool => tool.key === "inventory.balances.page")?.available).toBe(false);
  });
});
