import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { TenantContextSchema } from "@yummyai/contracts";
import { connectDatabase, migrateDatabase, withTenant, marketplaceAccounts, marketplaceCredentials, marketplaceAuthorizationSessions, marketplaceCapabilitySnapshots } from "@yummyai/database";
import { createMarketplaceSecretVault, HttpMarketplaceAuthorizationGateway } from "@yummyai/marketplace-connectors";
import { authorityBounded, requireMarketplaceAuthorityLegacyEnvironment, assertMarketplaceAuthorityOriginal177Graph,
  startMarketplaceAuthorityProvider, installMarketplaceAuthoritySyntheticEnvironment } from "../../../../tools/testing/marketplace-authority-legacy-upgrade.mjs";
import { AuditService } from "../audit/audit.service.js";
import { MarketplaceAuthorizationService } from "./marketplace-authorization.service.js";
import { MarketplaceAuthorityWorkspaceService } from "./marketplace-authority-workspace.service.js";

const target = requireMarketplaceAuthorityLegacyEnvironment(process.env, "pre-0178"), database = connectDatabase(target.url);
const root = fileURLToPath(new URL("../../../../", import.meta.url));
const RecordRow = z.record(z.string(), z.unknown());
const Seed = z.object({ type: z.literal("marketplace.authority.seeded177"), context: TenantContextSchema, memberId: z.uuidv7(), roleId: z.uuidv7(),
  cases: z.array(z.object({ kind: z.string(), accountId: z.uuidv7(), priorStatus: z.string(), finalStatus: z.string(), credentialRows: z.int(), snapshots: z.int(), defectObserved: z.literal(true) }).strict()).length(4),
  historyAccountId: z.uuidv7(), pendingInput: z.object({ state: z.string().min(1), code: z.string().min(1) }).strict(),
  rows: z.object({ accounts: z.array(RecordRow), credentials: z.array(RecordRow), sessions: z.array(RecordRow), capabilities: z.array(RecordRow) }).strict(), providerCounts: z.record(z.string(), z.number()) }).strict();
let child: ChildProcess | undefined, exited: Promise<void> | undefined;
afterAll(async () => { const errors: unknown[] = [];
  if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  try { if (exited) await authorityBounded(exited, "authority_upgrade_child_exit_timeout", 10_000); } catch (error) { errors.push(error); }
  try { await database.client.end(); } catch (error) { errors.push(error); } if (errors.length) throw new AggregateError(errors, "Authority upgrade cleanup failed"); });
describe("genuine original177 marketplace authority upgrade", () => {
  it("reproduces all four original177 lifecycle races then preserves every legacy column and requires legacy OAuth restart on178", async () => {
    await assertMarketplaceAuthorityOriginal177Graph(target.root);
    let receive!: (value: unknown) => void, reject!: (error: Error) => void;
    const seeded = new Promise<unknown>((yes, no) => { receive = yes; reject = no; });
    let received = false, startupCode: string | null = null;
    child = spawn(process.execPath, ["--import", pathToFileURL(resolve(target.root, "apps/api/node_modules/tsx/dist/loader.mjs")).href,
      resolve(root, "tools/testing/marketplace-authority-legacy-upgrade.mts")], { cwd: resolve(target.root, "apps/api"), windowsHide: true,
      stdio: ["ignore", "ignore", "pipe", "ipc"], env: { ...process.env, E2E_LEGACY_SCHEMA_TARGET: "current", E2E_MARKETPLACE_AUTHORITY_LEGACY_CHILD: "177",
        TSX_DISABLE_CACHE: "1", TSX_TSCONFIG_PATH: resolve(target.root, "apps/api/tsconfig.json") } });
    child.stderr?.on("data", (data: Buffer) => { const match = /\b(ERR_[A-Z0-9_]{1,64}|ENOENT|EACCES)\b/.exec(data.toString("utf8")); if (match) startupCode ??= match[1]!; });
    exited = new Promise(done => child!.once("exit", (code, signal) => { if (!received) reject(new Error("authority_original177_exited_before_seed:" + JSON.stringify({ code, signal, startupCode }))); done(); }));
    child.once("error", () => reject(new Error("authority_original177_spawn_failed")));
    child.on("message", raw => { if (!raw || typeof raw !== "object" || !("type" in raw)) return;
      if (raw.type === "marketplace.authority.seeded177") { received = true; receive(raw); }
      if (raw.type === "marketplace.authority.failed") {
        const safe = z.object({ type: z.literal("marketplace.authority.failed"), phase: z.string().regex(/^original177_[a-z_]{1,60}$/), code: z.string().regex(/^[A-Z0-9_]{1,80}$/).nullable(),
          errorName: z.string().regex(/^[A-Za-z]{1,40}$/), location: z.object({ file: z.string().regex(/^[A-Za-z0-9_./-]+$/), line: z.int().positive() }).strict().nullable() }).strict().safeParse(raw);
        reject(new Error("authority_original177_failed:" + JSON.stringify(safe.success ? safe.data : { phase: "original177_invalid_diagnostic" })));
      }
    });
    const seed = Seed.parse(await authorityBounded(seeded, "authority_original177_seed_timeout", 120_000));
    await authorityBounded(exited, "authority_original177_cleanup_timeout"); expect(child.exitCode).toBe(0); expect(child.signalCode === null).toBe(true);
    expect(seed.cases.map(row => row.kind)).toEqual(["oauth_after_revoke", "private_after_revoke", "normalcaps_after_revoke", "rotatedcaps_after_disable"]);
    await migrateDatabase(database);
    const current = await withTenant(database.db, seed.context, async tx => ({ accounts: await tx.select().from(marketplaceAccounts), credentials: await tx.select().from(marketplaceCredentials),
      sessions: await tx.select().from(marketplaceAuthorizationSessions), capabilities: await tx.select().from(marketplaceCapabilitySnapshots) }));
    for (const name of ["accounts", "credentials", "sessions", "capabilities"] as const) {
      const legacy = seed.rows[name], actual = JSON.parse(JSON.stringify(current[name])) as Array<Record<string, unknown>>;
      const selected = legacy.map(row => { const found = actual.find(next => next.id === row.id); if (!found) throw new Error("Original177 historical row missing");
        return Object.fromEntries(Object.keys(row).map(key => [key, found[key]])); });
      expect(selected).toEqual(legacy);
    }
    expect(current.sessions.every(row => row.authorizationGeneration === null && row.authorityCeiling === null)).toBe(true);
    expect(current.capabilities.every(row => row.authorizationGeneration === null)).toBe(true);
    const provider = await startMarketplaceAuthorityProvider(), restoreFetch = provider.installAuthorizationTransport(), restoreEnvironment = installMarketplaceAuthoritySyntheticEnvironment();
    try {
      const auth = new MarketplaceAuthorizationService(database, createMarketplaceSecretVault(), new HttpMarketplaceAuthorizationGateway(), new AuditService(database));
      const workspace = new MarketplaceAuthorityWorkspaceService(database), before = await workspace.get(seed.context, seed.historyAccountId);
      expect(before.lifecycle.capabilityCurrent).toBe(false); expect(before.lifecycle.capabilityGeneration === null).toBe(true);
      await expect(auth.completeOAuth(seed.context, seed.historyAccountId, seed.pendingInput)).rejects.toMatchObject({ status: 400 }); expect(provider.counts.oauth).toBe(0);
      const start = await auth.startOAuth(seed.context, seed.historyAccountId); await auth.completeOAuth(seed.context, seed.historyAccountId, provider.code(start.authorizationUrl));
      const after = await workspace.get(seed.context, seed.historyAccountId); expect(after.account.hasCredential).toBe(true);
      expect(after.lifecycle.authorizationGeneration === before.lifecycle.authorizationGeneration).toBe(false);
      expect(after.lifecycle.capabilityCurrent).toBe(false);
    } finally { await provider.close(); restoreFetch(); restoreEnvironment(); }
  });
});
