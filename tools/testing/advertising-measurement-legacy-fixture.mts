import process from "node:process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// No business module is imported until both the disposable resource boundary
// and the immutable original source files have been verified.
const workspace = fileURLToPath(new URL("../../", import.meta.url));
const root = process.env.E2E_ADVERTISING_MEASUREMENT_LEGACY_SOURCE;
const databaseUrl = new URL(process.env.DATABASE_URL ?? "postgres://invalid/invalid");
const nonce = /^\/order_daily_e2e_([a-f0-9]{32})$/.exec(databaseUrl.pathname)?.[1];
if (!process.connected || process.env.E2E_ISOLATED_DAILY !== "1" || process.env.E2E_ADVERTISING_MEASUREMENT_ISOLATED !== "1" ||
  !["postgres:", "postgresql:"].includes(databaseUrl.protocol) || !nonce || process.env.S3_PRIVATE_BUCKET !== `order-daily-e2e-${nonce}` ||
  !root || !isAbsolute(root) || resolve(root) !== resolve(workspace, ".artifacts/ordinary-api-source-148-41d9bb72"))
  throw new Error("Actual legacy advertising fixture requires its matching disposable IPC runner");
const manifest = JSON.parse(await readFile(resolve(workspace, "docs/project-control/checkpoints/2026-10-20-procurement-precision-9a62c173-source-before.json"), "utf8")) as {
  sha256: string; files: Array<{ path: string; sha256: string }>;
};
if (manifest.sha256 !== "f2bcaa079b2fe33eda7608e4d96b15d9f8a3ebdcde7135ba8ed087607db52501")
  throw new Error("Original advertising source manifest differs");
for (const path of ["apps/api/src/customer-intelligence/advertising.service.ts", "apps/api/src/customer-intelligence/ad-csv-parser.ts",
  "apps/api/src/customer-intelligence/ad-analysis.ts", "apps/api/src/customer-intelligence/ad-source.gateway.ts",
  "packages/contracts/src/customer-intelligence/advertising-workbench.ts"]) {
  const expected = manifest.files.find(file => file.path === path)?.sha256;
  if (!expected || createHash("sha256").update(await readFile(resolve(root, path))).digest("hex") !== expected)
    throw new Error("Original advertising source file differs");
}
type Context = { tenantId: string; userId: string; permissions: string[]; dataScope: "tenant" };
type Request = { type: "seed"; context: Context; accountId: string };
const request = await new Promise<Request>((complete, reject) => {
  const timer = setTimeout(() => { process.off("message", receive); reject(new Error("Legacy synthetic seed input deadline")); }, 10_000);
  const receive = (value: unknown) => {
    if (!value || typeof value !== "object" || !("type" in value) || value.type !== "seed") return;
    clearTimeout(timer); process.off("message", receive); complete(value as Request);
  };
  process.on("message", receive);
});
const id = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
if (!request.context || !id.test(request.context.tenantId) || !id.test(request.context.userId) || !id.test(request.accountId) ||
  request.context.dataScope !== "tenant" || JSON.stringify([...request.context.permissions].sort()) !== JSON.stringify([
    "customer_intelligence:read", "customer_intelligence:review", "customer_intelligence:write",
  ])) throw new Error("Legacy synthetic identity boundary differs");

const load = (path: string) => import(pathToFileURL(resolve(root, path)).href);
createRequire(pathToFileURL(resolve(root, "apps/api/package.json")))("reflect-metadata");
const { connectDatabase } = await load("packages/database/src/index.ts");
const { AdGoalFieldsSchema, AdImportInputSchema } = await load("packages/contracts/src/customer-intelligence/advertising-workbench.ts");
const { createEntityId } = await load("packages/contracts/src/common/ids.ts");
const { createStorageFromEnvironment, ClamAvScanner } = await load("packages/storage/src/index.ts");
const { AuditService } = await load("apps/api/src/audit/audit.service.ts");
const { AdvertisingService } = await load("apps/api/src/customer-intelligence/advertising.service.ts");
const { AdSourceGateway } = await load("apps/api/src/customer-intelligence/ad-source.gateway.ts");
const database = connectDatabase();
let phase = "legacy-owner";
try {
  const service = new AdvertisingService(database, new AuditService(database),
    new AdSourceGateway(createStorageFromEnvironment(), new ClamAvScanner()));
  const context = request.context, accountId = request.accountId;
  const header = "Date range,Advertiser ID,Ad product,Campaign ID,Ad Group ID,Currency,Impressions,Clicks,Purchases,Spend,Sales";
  const row = "2026-09-01 - 2026-09-15,synthetic-legacy,SP,legacy-campaign,legacy-group,USD,1000,40,4,10,40";
  const input = AdImportInputSchema.parse({ accountId, marketplaceByCurrency: { USD: "US" }, timezone: "America/Los_Angeles",
    attributionWindowDays: 7, attributionBasis: "click", observedAt: "2026-09-24T18:00:00.000Z", dateOrder: null,
    allowPartial: false, idempotencyKey: `synthetic-old-import-${createEntityId()}`, files: [
      { fileName: "synthetic-original-campaign.csv", content: `${header}\n${row}` },
      { fileName: "synthetic-original-product.csv", content: `${header},Advertised ASIN\n${row},B012345678` },
      { fileName: "synthetic-original-target.csv", content: `${header},Targeting ID,Targeting,Target bid,Targeting status\n${row},legacy-target,custom pillow,1,ENABLED` },
    ] });
  phase = "legacy-preview";
  const preview = await service.preview(context, input);
  if (!preview.canCommit) throw new Error("Original synthetic advertising preview cannot commit");
  phase = "legacy-commit";
  const original = { ...input, previewChecksum: preview.previewChecksum }, saved = await service.commit(context, original);
  phase = "legacy-goal";
  const goal = await service.saveGoal(context, { scope: { accountId, marketplace: "US", currency: "USD", asin: "B012345678" },
    expectedRevision: 0, fields: AdGoalFieldsSchema.parse({ mode: "profit_defense", effectiveFrom: "2026-09-01", targetAcosBps: 2100,
      unitPriceMinor: 10000, unitCostMinor: 7000, coreKeywords: [], protectedTerms: [], trialEndDate: null, trialSpendLimitMinor: null }),
    idempotencyKey: `synthetic-old-goal-${createEntityId()}` });
  phase = "legacy-analysis";
  const runInput = { accountId, periodStart: "2026-09-01", periodEnd: "2026-09-15", marketplace: null, currency: null,
    evidenceCutoffAt: new Date().toISOString(), idempotencyKey: `synthetic-old-analysis-${createEntityId()}` };
  const run = await service.analyze(context, runInput);
  const action = (await service.workspace(context, accountId)).actions.find((value: { recommendation: { kind: string } }) => value.recommendation.kind === "lower_bid");
  if (!action || action.recommendation.proposedBidMinor !== 85) throw new Error("Original synthetic legacy action differs");
  phase = "legacy-review";
  const reviewed = await service.transition(context, action.id, { expectedRevision: action.revision, expectedStatus: action.status, status: "adopted",
    reason: "Synthetic review only No real advertising operation", executedAt: null, actualBeforeMinor: null, actualAfterMinor: null,
    executionCampaignId: null, executionAdGroupId: null, executionTargetId: null, idempotencyKey: `synthetic-old-review-${createEntityId()}` });
  phase = "legacy-export";
  const exported = await service.sealExport(context, { runId: run.id, actionIds: [reviewed.id],
    reviewReason: "Synthetic immutable manual checklist No external advertising call", idempotencyKey: `synthetic-old-export-${createEntityId()}` });
  await database.client.end();
  process.send?.({ type: "advertising.measurement.legacy.seeded", seed: { original, saved, goal, runInput, run, exported } }, () => process.exit(0));
} catch (cause) {
  await database.client.end();
  const error = cause as { code?: unknown; cause?: { code?: unknown } };
  const code = [error?.code, error?.cause?.code].find(value => typeof value === "string" && /^(?:[0-9A-Z]{5}|ERR_[A-Z0-9_]{1,64}|ENOENT|EACCES|ECONNREFUSED|ETIMEDOUT)$/.test(value));
  process.send?.({ type: "advertising.measurement.legacy.failed", phase, ...(code ? { code } : {}) }, () => process.exit(1));
}
