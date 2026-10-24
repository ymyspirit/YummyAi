import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Permission } from "@yummyai/authz";
import { AGENT_MCP_TOOL_NAMES } from "@yummyai/contracts/ai/agent-mcp";
import { AGENT_NATIVE_V3_VERSION, AgentNativeV3ReceiptSchema } from "@yummyai/contracts/ai/agent-native-v3";
import { AGENT_MCP_READINESS_VERSION, AgentMcpReadinessResultSchema } from "@yummyai/contracts/ai/agent-mcp-readiness";
import { AgentReadinessFamilySchema, type AgentReadinessFamily } from "@yummyai/contracts/ai/agent-readiness";
import { erpSessionAuthority } from "@yummyai/contracts/auth/session";
import { connectDatabase } from "@yummyai/database";
import { requireAgentMcpReadinessEnvironment } from "../../../../tools/testing/require-agent-mcp-readiness-environment.mjs";
import { bounded } from "./agent-read.test-fixture.js";
import { agentMcpReadinessFixture, mcpReadinessHash, mcpReadinessQa, type ReadinessMcpClient } from "./agent-mcp-readiness.test-fixture.js";

const environment = requireAgentMcpReadinessEnvironment(), database = connectDatabase(environment.url), f = agentMcpReadinessFixture(database);
const families = AgentReadinessFamilySchema.exclude(["native_v4"]).options, allScopes = () => Object.fromEntries(Object.values(Permission).map(bit => [bit, "tenant" as const]));
const evidence: Array<{ scenario: string; sameFixedToken?: boolean; effectsUnchanged: boolean; expectedDenial?: string; syntheticQueuedAdmission?: boolean }> = [];
async function read(client: ReadinessMcpClient, family: AgentReadinessFamily) {
  const actual = await client.call(AGENT_MCP_TOOL_NAMES.execute, { version: AGENT_MCP_READINESS_VERSION, family });
  expect(actual.isError).toBe(false); expect(actual.packet.kind).toBe("read");
  const value = AgentMcpReadinessResultSchema.parse(actual.packet.data);
  expect(value.family).toBe(family); expect(actual.packet.contextAuthority).toBe(value.contextAuthority);
  expect(value.diagnostic.effects).toEqual({ modelCalls: 0, queueDispatches: 0, budgetReservations: 0, businessWrites: 0 });
  expect(value.diagnostic.notChecked).toEqual(["request_budget", "selected_sources", "provider_connection", "consumer_readiness"]);
  expect(value.selectedMcpStartInputsChecked).toBe(false); expect(value.advisoryOnly).toBe(true); return value;
}

describe.sequential("MCP readiness official stdio and original current RLS owners", () => {
  beforeAll(async () => { await mkdir(mcpReadinessQa, { recursive: true }); await f.initialize(); });
  afterAll(async () => {
    const failures: unknown[] = [];
    try { await f.close(); } catch (error) { failures.push(error); }
    try { await database.client.end(); } catch (error) { failures.push(error); }
    try { await writeFile(resolve(mcpReadinessQa, environment.nonce + "-mcp-readiness-proof.json"), JSON.stringify({ nonce: environment.nonce,
      scope: "synthetic_signer_real_oidc_membership_rls_original_owners_official_sdk_stdio_no_consumer",
      evidence, requests: f.requests, children: f.clients.map(client => client.evidence), cleanupFailed: failures.length !== 0 }, null, 2)); }
    catch (error) { failures.push(error); }
    if (failures.length) throw new AggregateError(failures, "mcp_readiness_acceptance_cleanup_failed");
  });

  it("sdk_stdio_five_families discovers exact schemas and reads original metadata with zero new admission", async () => {
    const { actor } = await f.readiness.actor(false); await f.readiness.policy(actor);
    const client = await f.connect(actor), session = await f.session(actor), before = await f.readiness.state(actor);
    const start = f.requests.length;
    expect((await client.client.listTools()).tools.map((tool: { name: string }) => tool.name).sort()).toEqual(Object.values(AGENT_MCP_TOOL_NAMES).sort());
    const found = await client.call(AGENT_MCP_TOOL_NAMES.search, { query: "readiness/", kind: "read", limit: 100 });
    expect(found.isError).toBe(false);
    const entries = found.packet.data.entries as Array<{ key: string; kind: string; available: boolean }>;
    expect(entries.map(item => item.key).sort()).toEqual(families.map(family => "readiness/" + family).sort());
    expect(entries.every(item => item.kind === "read" && item.available)).toBe(true);
    for (const family of families) {
      const schema = await client.call(AGENT_MCP_TOOL_NAMES.schema, { key: entries.find(item => item.key === "readiness/" + family)!.key });
      expect(schema.isError).toBe(false); expect(schema.packet.data).toMatchObject({ key: "readiness/" + family, family, metadataOnly: true,
        wrapperVersionRequired: AGENT_MCP_READINESS_VERSION, transport: "erp_execute", requestEncoding: "structured", automaticBusinessExecution: false });
      const input = schema.packet.data.inputSchema as { additionalProperties: boolean; required: string[]; properties: Record<string, unknown> };
      expect(input.additionalProperties).toBe(false); expect(input.required.slice().sort()).toEqual(["family", "version"]);
      expect(Object.keys(input.properties).sort()).toEqual(["family", "version"]);
      const value = await read(client, family);
      expect(value.contextAuthority).toBe(erpSessionAuthority(session)); expect(value.diagnostic.blockers).toContain("model_not_configured");
      expect(value.startupPolicy.allowedFamilies).toEqual([...families]); expect(value.startupPolicy.allowModelRun).toBe(false);
      expect(value.startupPolicy.allowPrepare).toBe(false); expect(value.startupPolicy.maxCostUsd).toBe(0);
      expect(value.startTransport).toBe(family === "native_v1" ? "original_native_v1" : "not_registered");
      expect(value.paidSubmissionEnabledByStartup).toBe(false);
    }
    expect(await f.readiness.state(actor)).toEqual(before);
    const requests = f.requests.slice(start); expect(requests.every(row => row.method === "GET" && row.status === 200)).toBe(true);
    expect(new Set(requests.map(row => row.credentialId)).size).toBe(1); expect(requests[0]!.credentialId).not.toBeNull();
    evidence.push({ scenario: "sdk_stdio_five_families", sameFixedToken: true, effectsUnchanged: true });
    await client.close(); expect(client.evidence.processExited).toBe(true); expect(client.evidence.credentialLeaked).toBe(false);
  });

  it("read_only_current_and_incoming_ceiling keeps organization budgets unchecked without inventing JWT role claims", async () => {
    const { actor } = await f.readiness.actor(); await f.readiness.policy(actor);
    const ceiling = await f.readiness.base.scopes(actor, { [Permission.WorkflowRead]: "tenant" }), fixed = await f.token(actor);
    const client = await f.connect(actor), before = await f.readiness.state(actor);
    for (const family of families) {
      const value = await read(client, family);
      expect(value.diagnostic.blockers).toContain("workflow_run_permission_missing"); expect(value.diagnostic.canConfigureModels).toBe(false);
      expect(value.diagnostic.checks).toMatchObject({ runPermission: "missing", taskBudget: "not_checked", monthlyBudget: "not_checked", concurrency: "not_checked" });
    }
    expect(await f.readiness.state(actor)).toEqual(before);
    await f.readiness.base.scopes(actor, allScopes());
    const afterGain = await f.readiness.state(actor), current = await read(client, "native_v3");
    expect(current.diagnostic.checks.runPermission).toBe("granted");
    expect(current.contextAuthority).toBe(erpSessionAuthority(await f.session(actor)));
    const originalCeiling = await f.readiness.service().get(ceiling, "native_v3");
    expect(originalCeiling.checks).toMatchObject({ runPermission: "missing", taskBudget: "not_checked", monthlyBudget: "not_checked", concurrency: "not_checked" });
    expect(originalCeiling.contextAuthority).not.toBe(current.contextAuthority);
    expect((await f.token(actor)).id).toBe(fixed.id); expect(await f.readiness.state(actor)).toEqual(afterGain);
    evidence.push({ scenario: "read_only_current_and_incoming_ceiling", sameFixedToken: true, effectsUnchanged: true });
  });

  it("current_workflow_read_revoke and disabled membership reject fixed-token calls without owner execution", async () => {
    const { actor } = await f.readiness.actor(false); const fixed = await f.token(actor), client = await f.connect(actor);
    await read(client, "native_v3");
    await f.readiness.base.scopes(actor, { [Permission.WorkflowRun]: "self" });
    let workspaces = 0; f.readiness.controls.afterWorkspace = async () => { workspaces++; };
    try {
      const before = await f.readiness.state(actor), denied = await client.call(AGENT_MCP_TOOL_NAMES.execute, { version: AGENT_MCP_READINESS_VERSION, family: "native_v3" });
      expect(denied.isError).toBe(true); expect(denied.packet.data).toMatchObject({ code: "mcp_http_failed", status: 403 });
      expect("diagnostic" in denied.packet.data).toBe(false); expect(workspaces).toBe(0); expect(await f.readiness.state(actor)).toEqual(before);
      await f.readiness.base.memberActive(actor, false);
      const inactive = await client.call(AGENT_MCP_TOOL_NAMES.execute, { version: AGENT_MCP_READINESS_VERSION, family: "native_v3" });
      expect(inactive.isError).toBe(true); expect(inactive.packet.data).toMatchObject({ code: "mcp_http_failed", status: 403 });
      expect((await f.token(actor)).id).toBe(fixed.id);
    } finally { f.readiness.controls.afterWorkspace = undefined; await f.readiness.base.memberActive(actor, true); }
    evidence.push({ scenario: "current_workflow_read_revoke", sameFixedToken: true, effectsUnchanged: true, expectedDenial: "mcp_http_failed403" });
  });

  it("late_workspace_and_http_result discard the real completed owner result after current role withdrawal", async () => {
    for (const stage of ["workspace", "http"] as const) {
      const { actor } = await f.readiness.actor(); await f.readiness.policy(actor);
      const client = await f.connect(actor), before = await f.readiness.state(actor), gate = f.hold(stage);
      const pending = client.call(AGENT_MCP_TOOL_NAMES.execute, { version: AGENT_MCP_READINESS_VERSION, family: "native_v3" });
      try {
        await bounded(Promise.race([gate.entered, pending.then(() => { throw new Error("mcp_readiness_finished_before_hold"); })]), "mcp_readiness_hold_not_entered");
        const next = allScopes(); delete next[Permission.WorkflowRun]; await f.readiness.base.scopes(actor, next);
        gate.release(); const actual = await pending;
        expect(actual.isError).toBe(true); expect(actual.packet.data).toMatchObject({ code: "mcp_authority_changed", status: 409 });
        expect("diagnostic" in actual.packet.data).toBe(false); expect("startupPolicy" in actual.packet.data).toBe(false);
        expect(await f.readiness.state(actor)).toEqual(before);
        evidence.push({ scenario: "late_" + stage, sameFixedToken: true, effectsUnchanged: true, expectedDenial: "mcp_authority_changed409" });
      } finally { gate.clear(); await pending; }
    }
  });

  it("startup_defaults_allowlist_and_tenant_identity reject unavailable families and secret-bearing extras without GET replay", async () => {
    const { actor } = await f.readiness.actor(false), foreign = await f.readiness.actor(); await f.readiness.policy(foreign.actor);
    const client = await f.connect(actor, []), session = await f.session(actor);
    const search = await client.call(AGENT_MCP_TOOL_NAMES.search, { query: "readiness/", kind: "read", limit: 100 });
    expect(search.isError).toBe(false); expect(search.packet.data.entries).toEqual([]);
    const start = f.requests.length;
    for (const name of [AGENT_MCP_TOOL_NAMES.schema, AGENT_MCP_TOOL_NAMES.execute]) {
      const actual = await client.call(name, name === AGENT_MCP_TOOL_NAMES.schema ? { key: "readiness/native_v3" } : { version: AGENT_MCP_READINESS_VERSION, family: "native_v3" });
      expect(actual.isError).toBe(true); expect(actual.packet.data).toMatchObject({ code: "mcp_policy_denied", status: 403 });
    }
    expect(f.requests.length).toBe(start);
    const scoped = await f.connect(actor, ["--allow-readiness=native_v3"]), foreignClient = await f.connect(foreign.actor, ["--allow-readiness=native_v3"]);
    const own = await read(scoped, "native_v3"), other = await read(foreignClient, "native_v3");
    expect(own.contextAuthority).toBe(erpSessionAuthority(session)); expect(other.contextAuthority).not.toBe(own.contextAuthority);
    expect(own.diagnostic.blockers).toContain("model_not_configured"); expect(other.diagnostic.checks.model).toBe("available");
    const before = f.requests.length, sentinel = "SYNTHETIC_MCP_READINESS_PRIVATE_INPUT";
    const wrong = await scoped.call(AGENT_MCP_TOOL_NAMES.execute, { version: AGENT_MCP_READINESS_VERSION, family: "loop" });
    expect(wrong.isError).toBe(true); expect(wrong.packet.data.code).toBe("mcp_policy_denied");
    let invalid: unknown;
    try { invalid = await scoped.client.callTool({ name: AGENT_MCP_TOOL_NAMES.execute, arguments: { version: AGENT_MCP_READINESS_VERSION, family: "native_v3", tenantId: foreign.actor.tenantId, [sentinel]: sentinel } }); }
    catch (error) { invalid = error instanceof Error ? error.message : "protocol_error"; }
    expect(JSON.stringify(invalid).includes(sentinel)).toBe(false); expect(JSON.stringify(invalid)).toContain("mcp_input_invalid");
    expect(f.requests.length).toBe(before);
    evidence.push({ scenario: "startup_defaults_allowlist_and_tenant_identity", sameFixedToken: true, effectsUnchanged: true });
  });

  it("existing_original_receipt remains readable after model disable with diagnostic admission effects measured separately", async () => {
    const { actor, modelId } = await f.readiness.actor(); await f.readiness.policy(actor);
    if (!modelId) throw new Error("mcp_readiness_synthetic_model_missing");
    // Original owner admission is an explicit synthetic queued setup, not a
    // consumer/provider run and not part of the subsequent zero-delta phase.
    const input = await f.readiness.nativeRequest(actor, modelId), context = await f.readiness.base.current(actor);
    const run = await f.readiness.owners.native_v3.start(context, input), proof = f.readiness.original.proof(input);
    const restore = await f.readiness.modelMode(actor, "disabled"), client = await f.connect(actor, ["--allow-native-v3", "--allow-readiness=native_v3"]);
    try {
      const before = await f.readiness.state(actor), view = await read(client, "native_v3");
      expect(view.diagnostic.blockers).toContain("model_routes_disabled");
      const original = await client.call(AGENT_MCP_TOOL_NAMES.savedResult, { version: AGENT_NATIVE_V3_VERSION, kind: "request_receipt", ...proof });
      expect(original.isError).toBe(false);
      const receipt = AgentNativeV3ReceiptSchema.parse(original.packet.data);
      expect(receipt.disposition).toBe("known"); expect(receipt.runId).toBe(run.id); expect(receipt.requestChecksum).toBe(proof.requestChecksum);
      const usage = await client.call(AGENT_MCP_TOOL_NAMES.usage, { version: AGENT_NATIVE_V3_VERSION, id: run.id });
      expect(usage.isError).toBe(false); expect(usage.packet.data.id).toBe(run.id);
      expect(await f.readiness.state(actor)).toEqual(before);
      expect(before.modelCalls).toBe(0); expect(before.sourceCalls).toBe(0);
      evidence.push({ scenario: "existing_original_receipt", effectsUnchanged: true, syntheticQueuedAdmission: true });
    } finally { await restore(); }
    expect(f.requests.every(row => row.method === "GET")).toBe(true);
    expect(f.clients.every(item => !item.evidence.credentialLeaked)).toBe(true);
    expect(mcpReadinessHash(JSON.stringify(evidence))).toMatch(/^[a-f0-9]{64}$/);
  });
});
