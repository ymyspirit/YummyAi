import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { connectDatabase, migrateDatabase, assertDatabaseMigrationsCurrent, readMigrationEvidence, withTenant } from "@yummyai/database";
import { type TenantContext } from "@yummyai/contracts";
import { CreatedIntegrationApiClientViewSchema, type IntegrationApiClientView } from "@yummyai/contracts/integration";
import { sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { captureLegacyDataCheckpoint } from "../../../../tools/testing/legacy-data-checkpoint.mjs";
import { agentDelegationFixture, agentDelegationSha, requireAgentDelegationEnvironment } from "../../../../tools/testing/agent-delegation-fixture.mjs";
import { observeInvoiceProcess, type InvoiceProcess } from "../procurement/invoice-command.fixtures.js";
import { DatabaseApiClientContextLoader } from "../auth/tenant-context.guard.js";

requireAgentDelegationEnvironment("pre-0171");
type LegacyClient = Omit<IntegrationApiClientView, "delegation" | "credentialState">;
type Original170 = { context: TenantContext; membershipId: string; roleId: string; activeInput: {
  label: string; scopes: Array<"inventory:read" | "finance:read">; expiresAt: null; idempotencyKey: string };
  activeClient: LegacyClient; activeToken: string; retiredClientId: string };

describe.sequential("genuine170 integration clients retain history and require a new pinned delegation", () => {
  const database = connectDatabase(); let child: InvoiceProcess | undefined;
  afterAll(async () => { try { if (child?.child.exitCode === null) await child.stop(true); } finally { await database.client.end(); } });

  it("preserves all original170 columns and client events while rejecting legacy authentication and issuing a fresh current membership delegation", async () => {
    const workspace = fileURLToPath(new URL("../../../../", import.meta.url));
    const prefix = resolve(workspace, "docs/project-control/checkpoints/2026-10-22-agent-delegation-a23e7b91");
    const materialized = JSON.parse(await readFile(`${prefix}-legacy-materialization.json`, "utf8"));
    const source = JSON.parse(await readFile(`${prefix}-source-before.json`, "utf8")) as { sha256: string; files: Array<{ path: string; sha256: string }> };
    const root = resolve(workspace, "tmp/agent-delegation-20261022-a23e7b91/old170-source");
    expect(materialized).toMatchObject({ verified: true, environmentFilesCopied: false, ordinaryChanged: false, sourceFiles: 3073,
      dependencyLinks: 309, sourceSha256: "d16eda6eb3c6cdfaecf7da13c30b287317e4daa2098a5d8ff6fe0e81cc480b78" });
    expect(resolve(materialized.target)).toBe(root); expect(resolve(process.env.E2E_AGENT_DELEGATION_LEGACY_SOURCE!)).toBe(root);
    expect(source.sha256).toBe(materialized.sourceSha256); expect(source.files).toHaveLength(3073);
    const verify = async () => { for (const row of source.files) expect(agentDelegationSha(await readFile(resolve(root, row.path))), row.path).toBe(row.sha256); };
    await verify();
    child = observeInvoiceProcess(spawn(process.execPath, ["--import", "./node_modules/tsx/dist/loader.mjs", resolve(workspace, "tools/testing/agent-delegation-legacy.mts")], {
      cwd: resolve(root, "apps/api"), windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"], env: { ...process.env,
        TSX_DISABLE_CACHE: "1", TSX_TSCONFIG_PATH: resolve(root, "apps/api/tsconfig.json"), E2E_LEGACY_SCHEMA_TARGET: "current", E2E_AGENT_DELEGATION_LEGACY_CHILD: "170" },
    }));
    let original: unknown;
    try { original = await child.wait("agent.delegation.seeded170", undefined, 90_000); }
    catch {
      const failure = child.events.filter(row => row.type === "agent.delegation.failed").at(-1);
      throw new Error(`Actual170 delegation child failed in ${failure?.phase ?? "unknown"} (code ${failure?.code ?? "unreported"})`);
    }
    await child.stop(false);
    const old = original as Original170;
    expect(old.context.permissionScopes).toBeDefined(); expect(old.membershipId).toMatch(/^[a-f0-9-]{36}$/);
    const journal = (await readMigrationEvidence(database)).actualRows; expect(journal).toHaveLength(170);
    const checkpoint = await captureLegacyDataCheckpoint(database), before = await checkpoint.snapshot();
    await migrateDatabase(database); await assertDatabaseMigrationsCurrent(database);
    const evidence = await readMigrationEvidence(database);
    expect(evidence.actualRows.slice(0, 170)).toEqual(journal); expect(evidence.actualRows.length).toBe(evidence.canonicalRows.length);
    expect(await checkpoint.snapshot()).toEqual(before);
    expect(await new DatabaseApiClientContextLoader(database).load(old.activeToken)).toBeNull();
    const [legacy] = await withTenant(database.db, old.context, tx => tx.execute<{ missing: number; total: number }>(sql`select count(*)::int as total,
      count(*) filter(where delegation is null and delegation_request is null and creation_transaction_id is null and revocation_transaction_id is null)::int as missing from integration_api_clients`));
    expect(legacy).toEqual({ total: 2, missing: 2 });
    const originalTarget = process.env.E2E_LEGACY_SCHEMA_TARGET;
    let current: ReturnType<typeof agentDelegationFixture>;
    try { process.env.E2E_LEGACY_SCHEMA_TARGET = "current"; current = agentDelegationFixture(database); }
    finally { process.env.E2E_LEGACY_SCHEMA_TARGET = originalTarget; }
    const view = await current.service.workspace(old.context), active = view.apiClients.find(row => row.id === old.activeClient.id);
    if (!active) throw new Error("Actual170 legacy client metadata required");
    const { delegation, credentialState, ...preserved } = active;
    expect(preserved).toEqual(old.activeClient); expect(delegation).toBeNull(); expect(credentialState).toBe("requires_reissue");
    expect(view.apiClients.find(row => row.id === old.retiredClientId)).toMatchObject({ status: "revoked", delegation: null });
    expect(await checkpoint.snapshot()).toEqual(before);
    const reissue = CreatedIntegrationApiClientViewSchema.parse(await current.service.createApiClient(old.context, {
      ...old.activeInput, idempotencyKey: current.input().idempotencyKey, scopeLimits: { "inventory:read": "self", "finance:read": "team" }, teamIds: [],
    }));
    expect(reissue.client.id).not.toBe(old.activeClient.id);
    expect(reissue.client.delegation).toMatchObject({ membershipId: old.membershipId, permissionScopes: { "inventory:read": "self", "finance:read": "team" }, teamIds: [] });
    if (!reissue.bearerToken) throw new Error("Fresh delegation must issue its one-time credential");
    expect(await current.loader.load(reissue.bearerToken)).toMatchObject({ userId: old.context.userId, tenantId: old.context.tenantId,
      permissionScopes: { "inventory:read": "self", "finance:read": "team" }, teamIds: [] });
    await verify();
  });
});
