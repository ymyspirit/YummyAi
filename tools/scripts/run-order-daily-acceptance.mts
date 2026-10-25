import { randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { isAbsolute, join } from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { connectDatabase } from "../../packages/database/src/client.ts";
import { migrateDatabase } from "../../packages/database/src/migrate.ts";
import { migrateFinanceCostAllocationLegacyDatabase, migrateFinanceCommandLegacyDatabase, migrateFactoryCapacityLegacyDatabase } from "../testing/quality-legacy-migration.mts";
import { migrateQualityLegacyDatabase, migrateShipmentLegacyDatabase, migrateQualityGroupsLegacyDatabase, migrateManufacturingLegacyDatabase, migrateManufacturingDeliveryLegacyDatabase, migrateShiposLegacyDatabase, migrateInventoryLegacyDatabase, migrateReceiptRequestLegacyDatabase, migrateIncomingLegacyDatabase, migrateProcurementLegacyDatabase, migrateProcurementPrecisionLegacyDatabase, migrateInvoiceCommandLegacyDatabase, migrateInvoiceReconciliationLegacyDatabase, migrateFinanceMonetaryLegacyDatabase, migrateFinancePayablesLegacyDatabase, migrateFinanceAuthorityLegacyDatabase, migrateFinancePayablesAdjustmentsLegacyDatabase } from "../testing/quality-legacy-migration.mts";
import { Permission } from "../../packages/authz/src/permissions.ts";
import { createEntityId } from "../../packages/contracts/src/index.ts";
import { createEnvironmentSecretVault } from "../../packages/ai-core/src/environment-vault.ts";
import { startShiposFixtureServer } from "../testing/shipos-fixture-server.ts";
import { startLogisticsFixtureServer } from "../testing/logistics-fixture-server.ts";
import { createKnowledgeBrowserSandbox } from "../testing/knowledge-browser-sandbox.mts";
import { workspaceIntegrationArgs } from "../testing/require-disposable-integration.mjs";
import { prepareAcceptanceOutput } from "../testing/acceptance-output.mjs";
import { ClamAvScanner } from "../../packages/storage/src/clamav-scanner.ts";
import { migrateProductionQuantityLegacyDatabase } from "../testing/production-quantity-legacy-migration.mts";
import { migrateQualityScrapLegacyDatabase } from "../testing/quality-scrap-legacy-migration.mts";
import { migrateFactoryErpImportLegacyDatabase } from "../testing/factory-erp-import-legacy.mts";
import { migrateFactoryErpBindingLegacyDatabase } from "../testing/factory-erp-binding-corrections-legacy.mts";
import { migrateFactoryErpVoidReviewLegacyDatabase } from "../testing/factory-erp-void-reviews-legacy.mts";
import { migrateFactoryErpSourceRetentionLegacyDatabase } from "../testing/factory-erp-source-retention-legacy.mts";
import { migrateKnowledgeEvaluationLegacyDatabase } from "../testing/knowledge-evaluation-legacy.mts";
import { migrateKnowledgeBenchmarkLegacyDatabase } from "../testing/knowledge-benchmark-legacy.mts";
import { migrateBusinessBenchmarkLegacyDatabase } from "../testing/business-benchmark-legacy.mts";
import { migrateRoleBenchmarkLegacyDatabase } from "../testing/role-benchmark-legacy.mts";
import { migrateAgentDelegationLegacyDatabase } from "../testing/agent-delegation-legacy.mts";
import { migrateAgentLoopLegacyDatabase } from "../testing/agent-loop-legacy.mts";
import { migrateAgentCommandLegacyDatabase } from "../testing/agent-command-legacy.mts";
import { migrateAgentPlanLegacyDatabase } from "../testing/agent-plan-legacy.mts";
import { migrateAgentNativeLegacyDatabase } from "../testing/agent-native-legacy-upgrade.mts";
import { migrateAgentNativeV2LegacyDatabase } from "../testing/agent-native-v2-legacy-upgrade.mts";
import { migrateAgentNativeV3LegacyDatabase } from "../testing/agent-native-v3-legacy-upgrade.mts";
import { migrateMarketplaceAuthorityLegacyDatabase } from "../testing/marketplace-authority-legacy-upgrade.mts";
import { startAgentMcpBrowserIdentityFixture } from "../testing/agent-mcp-auth-fixture.mts";
import { parseWebCandidateArgs, verifyLocalWebCandidate } from "./local-web-candidate.mjs";
import { startSealedStudioRuntime, verifyStudioRuntime } from "./serve-studio-runtime.mjs";
import { canvasRuntimeSourceStamp } from "./build-canvas-runtime.mjs";
import { requireStudioDocumentTransferBrowserLock } from "../testing/require-studio-document-transfer-browser-lock.mjs";
import {
  startFactoryIdentityFixture,
  factoryFixtureAccounts,
} from "../testing/factory-identity-fixture.mts";

const require = createRequire(import.meta.url);
const storageRequire = createRequire(
  new URL("../../packages/storage/package.json", import.meta.url),
);
const {
  S3Client,
  CreateBucketCommand,
  ListObjectsV2Command,
  ListObjectVersionsCommand,
  DeleteObjectsCommand,
  DeleteBucketCommand,
  HeadBucketCommand,
} = storageRequire("@aws-sdk/client-s3");
const { id: webCandidateId, nextArgs: acceptanceArgs } = parseWebCandidateArgs(process.argv.slice(2));
const specificationProductionIntegrationRequested = acceptanceArgs.includes("--suite=specification-production-integration");
if (specificationProductionIntegrationRequested && (webCandidateId || acceptanceArgs.some(arg =>
  arg !== "--suite=specification-production-integration" && arg !== "--cache=false")))
  throw new Error("Production specification acceptance accepts only its isolated suite and cache flag");
// This local browser selection is fixed by source and validated before any
// acceptance output, database client, bucket or disposable Redis is created.
const studioTransferBrowserSelection = process.argv.includes("--suite=studio-document-transfer-browser")
  ? requireStudioDocumentTransferBrowserLock(process.env) : null;
const studioTransferSuiteRequested = process.argv.includes("--suite=studio-document-transfer-browser")
  || process.argv.includes("--suite=studio-document-transfer-integration");
const studioVideoDirectoryBrowserSelection = process.argv.includes("--suite=studio-video-directory-browser")
  ? requireStudioDocumentTransferBrowserLock(process.env) : null;
const studioVideoDirectorySuiteRequested = process.argv.includes("--suite=studio-video-directory-browser")
  || process.argv.includes("--suite=studio-video-directory-integration");
const studioModelSelectionBrowserSelection = process.argv.includes("--suite=studio-model-selection-browser")
  ? requireStudioDocumentTransferBrowserLock(process.env) : null;
const studioModelSelectionSuiteRequested = process.argv.includes("--suite=studio-model-selection-browser")
  || process.argv.includes("--suite=studio-model-selection-integration");
const studioDraftRecoverySuiteRequested = process.argv.includes("--suite=studio-draft-recovery-browser");
const studioDraftRecoveryBrowserSelection = studioDraftRecoverySuiteRequested
  ? requireStudioDocumentTransferBrowserLock(process.env) : null;
const creativeRecoverySuiteRequested = process.argv.includes("--suite=creative-recovery-integration");
const token = randomUUID().replaceAll("-", "");
const name = `order_daily_e2e_${token}`,
  bucket = `order-daily-e2e-${token}`,
  redis = `yummyai-daily-${token}`;
const output = await prepareAcceptanceOutput({
  workspace: fileURLToPath(new URL("../../", import.meta.url)), token,
  requestedRoot: process.env.YUMMYAI_TEST_CACHE_DIR, args: acceptanceArgs,
});
const artifactDirectory = output.artifactDirectory;
const originalUrl = new URL(process.env.DATABASE_URL!),
  adminUrl = new URL(originalUrl);
adminUrl.pathname = "/postgres";
const testUrl = new URL(originalUrl);
testUrl.pathname = `/${name}`;
if (
  !/^order_daily_e2e_[a-f0-9]{32}$/.test(name) ||
  originalUrl.pathname === testUrl.pathname ||
  bucket === process.env.S3_PRIVATE_BUCKET
)
  throw new Error("Unsafe fixture resources");
const admin = connectDatabase(adminUrl.toString());
const client = new S3Client({
  endpoint: process.env.S3_ENDPOINT,
  forcePathStyle: true,
  region: process.env.S3_REGION ?? "us-east-1",
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY_ID!,
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY!,
  },
});
const manifest = {
  browserMode: "not_browser",
  artifactDirectory,
  browserOutputDirectory: output.browserOutputDirectory,
  outputOwnershipReceipt: output.receiptPath,
  webBuildId: null as string | null,
  webCandidateId: webCandidateId ?? null,
  operationalCandidatePreserved: webCandidateId ? true : null,
  database: name,
  bucket,
  redis,
  createdAt: new Date().toISOString(),
  databaseDeleted: false,
  bucketDeleted: false,
  redisDeleted: false,
  testExitCode: null as number | null,
  cleanupErrors: [] as string[],
  identityServiceClosed: null as boolean | null,
  browserSandboxDeleted: null as boolean | null,
  fileScannerEvidence: null as { engine: string; signatureVersion: string; result: "clean" } | null,
  studioRuntime: null as { bundleId: string; sourceStamp: string; closed: boolean } | null,
  studioTransferBrowser: studioTransferBrowserSelection?.metadata ?? null,
  studioVideoDirectoryBrowser: studioVideoDirectoryBrowserSelection?.metadata ?? null,
  studioModelSelectionBrowser: studioModelSelectionBrowserSelection?.metadata ?? null,
  studioDraftRecoveryBrowser: studioDraftRecoveryBrowserSelection?.metadata ?? null,
};
// Keep this family's complete raw output in its guarded owned leaf. Historical
// families keep their existing manifest location and evidence conventions.
const manifestPath = studioTransferSuiteRequested || studioVideoDirectorySuiteRequested || studioModelSelectionSuiteRequested || studioDraftRecoverySuiteRequested || creativeRecoverySuiteRequested ? join(artifactDirectory, "acceptance-manifest.json")
  : new URL(`../../tmp/order-daily-e2e-${token}.json`, import.meta.url);
await mkdir(new URL("../../tmp/", import.meta.url), { recursive: true });
await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
let exitCode = 1;
const qualityUpgradeIntegration = process.argv.includes("--suite=quality-upgrade-integration");
const shipmentSourcesIntegration = process.argv.includes("--suite=shipment-sources-integration");
const qualityGroupsIntegration = process.argv.includes("--suite=quality-groups-integration");
const qualityGroupsUpgradeIntegration = process.argv.includes("--suite=quality-groups-upgrade-integration");
const shipmentUpgradeIntegration = process.argv.includes("--suite=shipment-upgrade-integration");
const manufacturingUpgradeIntegration = process.argv.includes("--suite=manufacturing-upgrade-integration");
const manufacturingDeliveryUpgradeIntegration = process.argv.includes("--suite=manufacturing-delivery-upgrade-integration");
const shiposUpgradeIntegration = process.argv.includes("--suite=shipos-upgrade-integration");
const inventoryUpgradeIntegration = process.argv.includes("--suite=inventory-upgrade-integration");
const receiptRequestUpgradeIntegration = process.argv.includes("--suite=receipt-request-upgrade-integration");
const incomingUpgradeIntegration = process.argv.includes("--suite=incoming-upgrade-integration");
const procurementUpgradeIntegration = process.argv.includes("--suite=procurement-upgrade-integration");
const financeMonetaryIntegration = process.argv.includes("--suite=finance-monetary-integration");
const financeCommandBusinessIntegration = process.argv.includes("--suite=finance-command-business-integration");
const financeCommandResultIntegration = process.argv.includes("--suite=finance-command-result-integration");
const financeCommandResultBrowser = process.argv.includes("--suite=finance-command-result-browser");
const advertisingCommandIntegration = process.argv.includes("--suite=advertising-command-integration");
const advertisingCommandBrowser = process.argv.includes("--suite=advertising-command-browser");
const factoryAuthorityIntegration = process.argv.includes("--suite=factory-authority-integration");
const factoryAuthorityBrowser = process.argv.includes("--suite=factory-authority-browser");
const factoryCapacityIntegration = process.argv.includes("--suite=factory-capacity-integration");
const factoryCapacityUpgradeIntegration = process.argv.includes("--suite=factory-capacity-upgrade-integration");
const factoryCapacityBrowser = process.argv.includes("--suite=factory-capacity-browser");
const productionQuantityIntegration = process.argv.includes("--suite=production-quantity-integration");
const productionQuantityUpgradeIntegration = process.argv.includes("--suite=production-quantity-upgrade-integration");
const productionStopBrowser = process.argv.includes("--suite=production-stop-browser");
const qualityScrapIntegration = process.argv.includes("--suite=quality-scrap-integration");
const qualityScrapUpgradeIntegration = process.argv.includes("--suite=quality-scrap-upgrade-integration");
const qualityScrapBrowser = process.argv.includes("--suite=quality-scrap-browser");
const factoryErpImportIntegration = process.argv.includes("--suite=factory-erp-import-integration");
const factoryErpImportUpgradeIntegration = process.argv.includes("--suite=factory-erp-import-upgrade-integration");
const factoryErpImportBrowser = process.argv.includes("--suite=factory-erp-import-browser");
const factoryErpSourceRetentionIntegration = process.argv.includes("--suite=factory-erp-source-retention-integration");
const factoryErpSourceRetentionUpgradeIntegration = process.argv.includes("--suite=factory-erp-source-retention-upgrade-integration");
const factoryErpSourceRetentionBrowser = process.argv.includes("--suite=factory-erp-source-retention-browser");
const factoryErpBindingIntegration = process.argv.includes("--suite=factory-erp-binding-corrections-integration");
const factoryErpBindingUpgradeIntegration = process.argv.includes("--suite=factory-erp-binding-corrections-upgrade-integration");
const factoryErpBindingBrowser = process.argv.includes("--suite=factory-erp-binding-corrections-browser");
const factoryErpVoidReviewIntegration = process.argv.includes("--suite=factory-erp-void-reviews-integration");
const factoryErpVoidReviewUpgradeIntegration = process.argv.includes("--suite=factory-erp-void-reviews-upgrade-integration");
const factoryErpVoidReviewBrowser = process.argv.includes("--suite=factory-erp-void-reviews-browser");
const knowledgeEvaluationIntegration = process.argv.includes("--suite=knowledge-evaluation-execution-integration");
const knowledgeEvaluationUpgradeIntegration = process.argv.includes("--suite=knowledge-evaluation-execution-upgrade-integration");
const knowledgeEvaluationBrowser = process.argv.includes("--suite=knowledge-evaluation-execution-browser");
const knowledgeBenchmarkIntegration = process.argv.includes("--suite=knowledge-benchmark-integration");
const knowledgeBenchmarkUpgradeIntegration = process.argv.includes("--suite=knowledge-benchmark-upgrade-integration");
const knowledgeBenchmarkBrowser = process.argv.includes("--suite=knowledge-benchmark-browser");
const knowledgeBenchmarkAny = knowledgeBenchmarkIntegration || knowledgeBenchmarkUpgradeIntegration || knowledgeBenchmarkBrowser;
const agentDelegationIntegration = process.argv.includes("--suite=agent-delegation-integration");
const agentDelegationUpgradeIntegration = process.argv.includes("--suite=agent-delegation-upgrade-integration");
const agentDelegationBrowser = process.argv.includes("--suite=agent-delegation-browser");
const agentReadIntegration = process.argv.includes("--suite=agent-read-integration");
const agentReadBrowser = process.argv.includes("--suite=agent-read-browser");
const agentMcpV2Integration=process.argv.includes("--suite=agent-mcp-v2-integration");
const marketplaceAuthorityIntegration = process.argv.includes("--suite=marketplace-authority-integration");
const marketplaceAuthorityUpgradeIntegration = process.argv.includes("--suite=marketplace-authority-upgrade-integration");
const marketplaceAuthorityBrowser = process.argv.includes("--suite=marketplace-authority-browser");
const storeNodeIdentityIntegration = process.argv.includes("--suite=store-node-identity-integration");
const storeNodeIdentityUpgradeIntegration = process.argv.includes("--suite=store-node-identity-upgrade-integration");
const storeNodeIdentityBrowser = process.argv.includes("--suite=store-node-identity-browser");
const storeNodeExecutionIntegration = process.argv.includes("--suite=store-node-execution-integration");
const storeNodeExecutionUpgradeIntegration = process.argv.includes("--suite=store-node-execution-upgrade-integration");
const storeNodeExecutionBrowser = process.argv.includes("--suite=store-node-execution-browser");
const publicationNodePreviewIntegration=process.argv.includes("--suite=publication-node-preview-integration");
const publicationAuthorityIntegration=process.argv.includes("--suite=publication-authority-integration");
const publicationAuthorityBrowser=process.argv.includes("--suite=publication-authority-browser");
const amazonPublicNodeIntegration=process.argv.includes("--suite=amazon-public-node-integration");
const amazonPublicNodeBrowser=process.argv.includes("--suite=amazon-public-node-browser");
const publicationNodeSubmitIntegration=process.argv.includes("--suite=publication-node-submit-integration");
const publicationNodeSubmitUpgradeIntegration=process.argv.includes("--suite=publication-node-submit-upgrade-integration");
const publicationNodeSubmitBrowser=process.argv.includes("--suite=publication-node-submit-browser");
const anyPublicationNodeSubmit=publicationNodeSubmitIntegration||publicationNodeSubmitUpgradeIntegration||publicationNodeSubmitBrowser;
process.env.E2E_PUBLICATION_NODE_SUBMIT_ISOLATED=anyPublicationNodeSubmit?"1":"0";
if(publicationNodeSubmitUpgradeIntegration&&!isAbsolute(process.env.E2E_PUBLICATION_NODE_SUBMIT_LEGACY_SOURCE??""))throw new Error("Actual original182 source required for Publication submission upgrade");
process.env.E2E_AMAZON_PUBLIC_NODE_ISOLATED=amazonPublicNodeIntegration||amazonPublicNodeBrowser?"1":"0";
process.env.E2E_PUBLICATION_AUTHORITY_ISOLATED=publicationAuthorityIntegration||publicationAuthorityBrowser?"1":"0";
const publicationNodePreviewUpgradeIntegration=process.argv.includes("--suite=publication-node-preview-upgrade-integration");
const publicationNodePreviewBrowser=process.argv.includes("--suite=publication-node-preview-browser");
const anyPublicationNodePreview=anyPublicationNodeSubmit||amazonPublicNodeIntegration||amazonPublicNodeBrowser||publicationAuthorityIntegration||publicationAuthorityBrowser||publicationNodePreviewIntegration||publicationNodePreviewUpgradeIntegration||publicationNodePreviewBrowser;
process.env.E2E_PUBLICATION_NODE_PREVIEW_ISOLATED=anyPublicationNodePreview?"1":"0";
if(publicationNodePreviewUpgradeIntegration&&!isAbsolute(process.env.E2E_PUBLICATION_NODE_PREVIEW_LEGACY_SOURCE??""))throw new Error("Actual original181 source required for Publication node preview upgrade");
const listingSyncIntentIntegration = process.argv.includes("--suite=listing-sync-intent-integration");
const listingSyncIntentUpgradeIntegration = process.argv.includes("--suite=listing-sync-intent-upgrade-integration");
const listingSyncIntentBrowser = process.argv.includes("--suite=listing-sync-intent-browser");
process.env.E2E_LISTING_SYNC_INTENT_ISOLATED = listingSyncIntentIntegration || listingSyncIntentUpgradeIntegration || listingSyncIntentBrowser ? "1" : "0";
if (listingSyncIntentUpgradeIntegration && !isAbsolute(process.env.E2E_LISTING_SYNC_INTENT_LEGACY_SOURCE ?? ""))
  throw new Error("Actual original180 source is required for Listing sync intent upgrade");
process.env.E2E_STORE_NODE_EXECUTION_ISOLATED = anyPublicationNodePreview || storeNodeExecutionIntegration || storeNodeExecutionUpgradeIntegration || storeNodeExecutionBrowser ? "1" : "0";
if (storeNodeExecutionUpgradeIntegration && !isAbsolute(process.env.E2E_STORE_NODE_EXECUTION_LEGACY_SOURCE ?? ""))
  throw new Error("Actual original179 source is required for store node execution upgrade");
process.env.E2E_STORE_NODE_IDENTITY_ISOLATED = storeNodeIdentityIntegration || storeNodeIdentityUpgradeIntegration || storeNodeIdentityBrowser ? "1" : "0";
if (storeNodeIdentityUpgradeIntegration && !isAbsolute(process.env.E2E_STORE_NODE_LEGACY_SOURCE ?? ""))
  throw new Error("Actual original178 source is required for store node identity upgrade");
process.env.E2E_MARKETPLACE_AUTHORITY_ISOLATED = marketplaceAuthorityIntegration || marketplaceAuthorityUpgradeIntegration || marketplaceAuthorityBrowser ? "1" : "0";
if (marketplaceAuthorityUpgradeIntegration && !isAbsolute(process.env.E2E_MARKETPLACE_AUTHORITY_LEGACY_SOURCE ?? ""))
  throw new Error("Actual original177 source is required for marketplace authority upgrade");
const agentMcpV2Browser=process.argv.includes("--suite=agent-mcp-v2-browser");
const anyAgentMcpV2=agentMcpV2Integration||agentMcpV2Browser;
process.env.E2E_AGENT_MCP_V2_ISOLATED=anyAgentMcpV2?"1":"0";
const fulfillmentCommandIntegration = process.argv.includes("--suite=fulfillment-command-integration");
const fulfillmentCommandUpgradeIntegration = process.argv.includes("--suite=fulfillment-command-upgrade-integration");
const fulfillmentCommandBrowser = process.argv.includes("--suite=fulfillment-command-browser");
const orderSummaryIntegration = process.argv.includes("--suite=order-summary-availability-integration");
const orderSummaryBrowser = process.argv.includes("--suite=order-summary-availability-browser");
const agentFulfillmentCommandIntegration = process.argv.includes("--suite=agent-fulfillment-command-integration");
const agentNativeV4Integration = process.argv.includes("--suite=agent-native-v4-integration");
const agentNativeV4LateIntegration = process.argv.includes("--suite=agent-native-v4-late-integration");
const agentNativeV4UpgradeIntegration = process.argv.includes("--suite=agent-native-v4-upgrade-integration");
const agentNativeV4Browser = process.argv.includes("--suite=agent-native-v4-browser");
const shipmentCreateIntegration = process.argv.includes("--suite=shipment-create-integration");
const shipmentCreateBrowser = process.argv.includes("--suite=shipment-create-browser");
const studioOriginalIntegration = process.argv.includes("--suite=studio-original-integration");
const studioOriginalBrowser = process.argv.includes("--suite=studio-original-browser");
const studioDocumentTransferIntegration = process.argv.includes("--suite=studio-document-transfer-integration");
const studioDocumentTransferBrowser = process.argv.includes("--suite=studio-document-transfer-browser");
const studioVideoDirectoryIntegration = process.argv.includes("--suite=studio-video-directory-integration");
const studioVideoDirectoryBrowser = process.argv.includes("--suite=studio-video-directory-browser");
const studioModelSelectionIntegration = process.argv.includes("--suite=studio-model-selection-integration");
const studioModelSelectionBrowser = process.argv.includes("--suite=studio-model-selection-browser");
const studioDraftRecoveryBrowser = studioDraftRecoverySuiteRequested;
const creativeRecoveryIntegration = creativeRecoverySuiteRequested;
process.env.E2E_CREATIVE_RECOVERY_ISOLATED = creativeRecoveryIntegration ? "1" : "0";
const studioPersonalIntegration = creativeRecoveryIntegration || studioModelSelectionIntegration || studioVideoDirectoryIntegration || studioDocumentTransferIntegration || studioOriginalIntegration || process.argv.includes("--suite=creative-studio-personal-integration");
const studioPersonalBrowser = studioDraftRecoveryBrowser || studioModelSelectionBrowser || studioVideoDirectoryBrowser || studioDocumentTransferBrowser || studioOriginalBrowser || process.argv.includes("--suite=creative-studio-personal-browser");
// These dedicated current-schema families require a bounded physical DB pool.
// Set it in the disposable owner, so CI and local callers share the same gate.
if (studioPersonalIntegration || studioPersonalBrowser) process.env.DATABASE_POOL_SIZE = "1";
process.env.E2E_STUDIO_DRAFT_RECOVERY_ISOLATED = studioDraftRecoveryBrowser ? "1" : "0";
process.env.E2E_STUDIO_MODEL_SELECTION_ISOLATED = studioModelSelectionIntegration || studioModelSelectionBrowser ? "1" : "0";
process.env.E2E_STUDIO_VIDEO_DIRECTORY_ISOLATED = studioVideoDirectoryIntegration || studioVideoDirectoryBrowser ? "1" : "0";
process.env.E2E_STUDIO_ORIGINAL_ISOLATED = studioOriginalIntegration || studioOriginalBrowser ? "1" : "0";
process.env.E2E_STUDIO_DOCUMENT_TRANSFER_ISOLATED = studioDocumentTransferIntegration || studioDocumentTransferBrowser ? "1" : "0";
process.env.YUMMYAI_STUDIO_PERSONAL_TEST_ISOLATION = studioPersonalIntegration || studioPersonalBrowser ? "1" : "0";
if (studioPersonalBrowser) {
  process.env.CANVAS_STUDIO_PRODUCTION_ENABLED = "1";
  process.env.CANVAS_STUDIO_URL = "http://127.0.0.1:4316";
}
process.env.E2E_SHIPMENT_CREATE_ISOLATED = shipmentCreateIntegration || shipmentCreateBrowser ? "1" : "0";
const anyAgentNativeV4 = shipmentCreateIntegration || shipmentCreateBrowser || agentNativeV4Integration || agentNativeV4LateIntegration || agentNativeV4UpgradeIntegration || agentNativeV4Browser;
process.env.E2E_AGENT_NATIVE_V4_ISOLATED = anyAgentNativeV4 ? "1" : "0";
process.env.E2E_AGENT_NATIVE_V4_UPGRADE_ISOLATED = agentNativeV4UpgradeIntegration ? "1" : "0";
if (agentNativeV4UpgradeIntegration) process.env.E2E_AGENT_NATIVE_V4_LEGACY_SOURCE ??= fileURLToPath(new URL("../../.artifacts/ordinary-api-source-186-d6b2f901-r9", import.meta.url));
const agentFulfillmentCommandUpgradeIntegration = process.argv.includes("--suite=agent-fulfillment-command-upgrade-integration");
const agentFulfillmentCommandBrowser = process.argv.includes("--suite=agent-fulfillment-command-browser");
process.env.E2E_AGENT_FULFILLMENT_COMMAND_ISOLATED = anyAgentNativeV4 || agentFulfillmentCommandIntegration || agentFulfillmentCommandUpgradeIntegration || agentFulfillmentCommandBrowser ? "1" : "0";
process.env.E2E_AGENT_FULFILLMENT_COMMAND_UPGRADE_ISOLATED = agentFulfillmentCommandUpgradeIntegration ? "1" : "0";
if (agentFulfillmentCommandUpgradeIntegration && !isAbsolute(process.env.E2E_AGENT_FULFILLMENT_COMMAND_LEGACY_SOURCE ?? "")) throw new Error("Actual original185 source required for Agent fulfillment upgrade");
process.env.E2E_ORDER_SUMMARY_AVAILABILITY_ISOLATED = orderSummaryIntegration || orderSummaryBrowser ? "1" : "0";
process.env.E2E_FULFILLMENT_COMMAND_ISOLATED = anyAgentNativeV4 || fulfillmentCommandIntegration || fulfillmentCommandUpgradeIntegration || fulfillmentCommandBrowser || agentFulfillmentCommandIntegration || agentFulfillmentCommandUpgradeIntegration || agentFulfillmentCommandBrowser ? "1" : "0";
if (fulfillmentCommandUpgradeIntegration && !isAbsolute(process.env.E2E_FULFILLMENT_COMMAND_LEGACY_SOURCE ?? "")) throw new Error("Actual original184 source required for fulfillment recovery upgrade");
const agentDependencyPlanIntegration = process.argv.includes("--suite=agent-dependency-plan-integration");
const agentDependencyPlanUpgradeIntegration = process.argv.includes("--suite=agent-dependency-plan-upgrade-integration");
const agentDependencyPlanBrowser = process.argv.includes("--suite=agent-dependency-plan-browser");
const anyAgentDependencyPlan = agentDependencyPlanIntegration || agentDependencyPlanUpgradeIntegration || agentDependencyPlanBrowser;
process.env.E2E_AGENT_DEPENDENCY_PLAN_ISOLATED = anyAgentDependencyPlan ? "1" : "0";
if (agentDependencyPlanUpgradeIntegration && !isAbsolute(process.env.E2E_AGENT_DEPENDENCY_PLAN_LEGACY_SOURCE ?? "")) throw new Error("Actual original183 source required for dependency plan upgrade");
const agentReadinessIntegration = process.argv.includes("--suite=agent-readiness-integration");
const agentReadinessBrowser = process.argv.includes("--suite=agent-readiness-browser");
const agentRuntimeReadinessIntegration = process.argv.includes("--suite=agent-runtime-readiness-integration");
const agentRuntimeReadinessBrowser = process.argv.includes("--suite=agent-runtime-readiness-browser");
const anyAgentRuntimeReadiness = agentRuntimeReadinessIntegration || agentRuntimeReadinessBrowser;
process.env.E2E_AGENT_RUNTIME_READINESS_ISOLATED = anyAgentRuntimeReadiness ? "1" : "0";
const agentMcpReadinessIntegration = process.argv.includes("--suite=agent-mcp-readiness-integration");
const agentMcpReadinessBrowser = process.argv.includes("--suite=agent-mcp-readiness-browser");
const anyAgentMcpReadiness = agentMcpReadinessIntegration || agentMcpReadinessBrowser;
process.env.E2E_AGENT_MCP_READINESS_ISOLATED = anyAgentMcpReadiness ? "1" : "0";
process.env.E2E_AGENT_READINESS_ISOLATED = anyAgentRuntimeReadiness || anyAgentMcpReadiness || agentReadinessIntegration || agentReadinessBrowser ? "1" : "0";
const agentNativeV3Integration=process.argv.includes("--suite=agent-native-v3-integration");
const agentNativeV3UpgradeIntegration=process.argv.includes("--suite=agent-native-v3-upgrade-integration");
const agentNativeV3Browser=process.argv.includes("--suite=agent-native-v3-browser");
const anyAgentNativeV3=anyAgentNativeV4||anyAgentRuntimeReadiness||anyPublicationNodePreview||anyAgentMcpV2||anyAgentMcpReadiness||agentReadinessIntegration||agentReadinessBrowser||agentNativeV3Integration||agentNativeV3UpgradeIntegration||agentNativeV3Browser;
process.env.E2E_AGENT_NATIVE_V3_ISOLATED=anyAgentNativeV3?"1":"0";
if(agentNativeV3UpgradeIntegration&&(!process.env.E2E_AGENT_NATIVE_V3_LEGACY_SOURCE||!isAbsolute(process.env.E2E_AGENT_NATIVE_V3_LEGACY_SOURCE)))throw new Error("Actual original176 source required for nativeV3 upgrade");
const agentNativeV2Integration=process.argv.includes("--suite=agent-native-v2-integration");
const agentFulfillmentIntegration = process.argv.includes("--suite=agent-fulfillment-integration");
const agentFulfillmentBrowser = process.argv.includes("--suite=agent-fulfillment-browser");
const anyAgentFulfillment = anyAgentNativeV3 || agentFulfillmentIntegration || agentFulfillmentBrowser;
const agentNativeV2UpgradeIntegration=process.argv.includes("--suite=agent-native-v2-upgrade-integration");
const agentNativeV2Browser=process.argv.includes("--suite=agent-native-v2-browser");
const anyAgentNativeV2=anyAgentNativeV3||agentNativeV2Integration||agentNativeV2UpgradeIntegration||agentNativeV2Browser;
process.env.E2E_AGENT_NATIVE_V2_ISOLATED=anyAgentNativeV2?"1":"0";
if(agentNativeV2UpgradeIntegration&&(!process.env.E2E_AGENT_NATIVE_V2_LEGACY_SOURCE||!isAbsolute(process.env.E2E_AGENT_NATIVE_V2_LEGACY_SOURCE)))throw new Error("Actual original175 source required for nativeV2 upgrade");
const agentResourcesIntegration=process.argv.includes("--suite=agent-resources-integration");
const agentResourcesBrowser=process.argv.includes("--suite=agent-resources-browser");
const anyAgentResources=anyAgentNativeV2||agentResourcesIntegration||agentResourcesBrowser;
process.env.E2E_AGENT_RESOURCES_ISOLATED=anyAgentResources?"1":"0";
const agentMcpIntegration=process.argv.includes("--suite=agent-mcp-integration");
const agentMcpBrowser=process.argv.includes("--suite=agent-mcp-browser");
process.env.E2E_AGENT_MCP_ISOLATED=anyAgentResources||agentMcpIntegration||agentMcpBrowser?"1":"0";
const agentNativeIntegration=process.argv.includes("--suite=agent-native-integration");
const agentNativeUpgradeIntegration=process.argv.includes("--suite=agent-native-upgrade-integration");
const agentNativeBrowser=process.argv.includes("--suite=agent-native-browser");
const anyAgentNative=anyAgentResources||agentMcpIntegration||agentMcpBrowser||agentNativeIntegration||agentNativeUpgradeIntegration||agentNativeBrowser;
process.env.E2E_AGENT_NATIVE_ISOLATED=anyAgentNative?"1":"0";
if(agentNativeUpgradeIntegration&&(!process.env.E2E_AGENT_NATIVE_LEGACY_SOURCE||!isAbsolute(process.env.E2E_AGENT_NATIVE_LEGACY_SOURCE)))throw new Error("Actual original174 source required for native Agent upgrade");
const agentToolsIntegration=process.argv.includes("--suite=agent-tools-integration");
const agentToolsBrowser=process.argv.includes("--suite=agent-tools-browser");
const anyAgentTools=agentToolsIntegration||agentToolsBrowser||anyAgentNative;
process.env.E2E_AGENT_TOOLS_ISOLATED=anyAgentTools?"1":"0";
const agentPlanIntegration=process.argv.includes("--suite=agent-plan-integration");
const agentPlanUpgradeIntegration=process.argv.includes("--suite=agent-plan-upgrade-integration");
const agentPlanBrowser=process.argv.includes("--suite=agent-plan-browser");
const anyAgentPlan=agentPlanIntegration||agentPlanUpgradeIntegration||agentPlanBrowser||anyAgentNative;
process.env.E2E_AGENT_PLAN_ISOLATED=anyAgentPlan?"1":"0";
if(agentPlanUpgradeIntegration&&(!process.env.E2E_AGENT_PLAN_LEGACY_SOURCE||!isAbsolute(process.env.E2E_AGENT_PLAN_LEGACY_SOURCE)))throw new Error("Actual original173 source required for Agent plan upgrade");
const agentCommandIntegration = process.argv.includes("--suite=agent-command-integration");
const agentCommandUpgradeIntegration = process.argv.includes("--suite=agent-command-upgrade-integration");
const agentCommandBrowser = process.argv.includes("--suite=agent-command-browser");
process.env.E2E_AGENT_COMMAND_ISOLATED = anyAgentDependencyPlan || agentCommandIntegration || agentCommandUpgradeIntegration || agentCommandBrowser || anyAgentPlan || anyAgentTools ? "1" : "0";
if (agentCommandUpgradeIntegration && (!process.env.E2E_AGENT_COMMAND_LEGACY_SOURCE || !isAbsolute(process.env.E2E_AGENT_COMMAND_LEGACY_SOURCE))) throw new Error("Actual original172 source required for Agent command upgrade");
const agentLoopIntegration = process.argv.includes("--suite=agent-loop-integration");
const agentLoopUpgradeIntegration = process.argv.includes("--suite=agent-loop-upgrade-integration");
const agentLoopBrowser = process.argv.includes("--suite=agent-loop-browser");
process.env.E2E_AGENT_LOOP_ISOLATED = agentLoopIntegration || agentLoopUpgradeIntegration || agentLoopBrowser || agentCommandUpgradeIntegration || anyAgentPlan ? "1" : "0";
if (agentLoopUpgradeIntegration && (!process.env.E2E_AGENT_LOOP_LEGACY_SOURCE || !isAbsolute(process.env.E2E_AGENT_LOOP_LEGACY_SOURCE))) throw new Error("Actual original171 source required for Agent loop upgrade");
const agentEntryIntegration = process.argv.includes("--suite=agent-entry-integration");
const agentEntryBrowser = process.argv.includes("--suite=agent-entry-browser");
process.env.E2E_AGENT_ENTRY_ISOLATED = agentEntryIntegration || agentEntryBrowser ? "1" : "0";
process.env.E2E_AGENT_READ_ISOLATED = anyAgentTools || agentReadIntegration || agentReadBrowser || agentEntryIntegration || agentEntryBrowser || agentLoopIntegration || agentLoopUpgradeIntegration || agentLoopBrowser || agentCommandUpgradeIntegration || anyAgentPlan ? "1" : "0";
process.env.E2E_AGENT_DELEGATION_ISOLATED = agentDelegationIntegration || agentDelegationUpgradeIntegration || agentDelegationBrowser ? "1" : "0";
if (agentDelegationUpgradeIntegration && (!process.env.E2E_AGENT_DELEGATION_LEGACY_SOURCE || !isAbsolute(process.env.E2E_AGENT_DELEGATION_LEGACY_SOURCE))) throw new Error("Actual original170 source required for Agent delegation upgrade");
const roleBenchmarkIntegration = process.argv.includes("--suite=role-benchmark-integration");
const roleBenchmarkUpgradeIntegration = process.argv.includes("--suite=role-benchmark-upgrade-integration");
const roleBenchmarkBrowser = process.argv.includes("--suite=role-benchmark-browser");
const roleBenchmarkAny = roleBenchmarkIntegration || roleBenchmarkUpgradeIntegration || roleBenchmarkBrowser;
process.env.E2E_ROLE_BENCHMARK_ISOLATED = anyAgentTools || roleBenchmarkAny ? "1" : "0";
if (roleBenchmarkUpgradeIntegration && (!process.env.E2E_ROLE_BENCHMARK_LEGACY_SOURCE || !isAbsolute(process.env.E2E_ROLE_BENCHMARK_LEGACY_SOURCE)))
  throw new Error("Actual original169 source required for role benchmark upgrade");
const businessBenchmarkIntegration = process.argv.includes("--suite=business-benchmark-integration");
const businessBenchmarkUpgradeIntegration = process.argv.includes("--suite=business-benchmark-upgrade-integration");
const businessBenchmarkBrowser = process.argv.includes("--suite=business-benchmark-browser");
const businessBenchmarkAny = businessBenchmarkIntegration || businessBenchmarkUpgradeIntegration || businessBenchmarkBrowser;
process.env.E2E_BUSINESS_BENCHMARK_ISOLATED = anyAgentTools || businessBenchmarkAny || roleBenchmarkAny ? "1" : "0";
process.env.E2E_KNOWLEDGE_BENCHMARK_ISOLATED = anyAgentTools || knowledgeBenchmarkAny || businessBenchmarkAny || roleBenchmarkAny ? "1" : "0";
process.env.E2E_KNOWLEDGE_EVALUATION_ISOLATED = anyAgentTools || knowledgeBenchmarkAny || businessBenchmarkAny || roleBenchmarkAny || knowledgeEvaluationIntegration || knowledgeEvaluationUpgradeIntegration || knowledgeEvaluationBrowser ? "1" : "0";
if (businessBenchmarkUpgradeIntegration && (!process.env.E2E_BUSINESS_BENCHMARK_LEGACY_SOURCE || !isAbsolute(process.env.E2E_BUSINESS_BENCHMARK_LEGACY_SOURCE))) throw new Error("Actual original168 source required for business benchmark upgrade");
if (knowledgeBenchmarkUpgradeIntegration && (!process.env.E2E_KNOWLEDGE_BENCHMARK_LEGACY_SOURCE || !isAbsolute(process.env.E2E_KNOWLEDGE_BENCHMARK_LEGACY_SOURCE))) throw new Error("Actual original167 source required for knowledge benchmark upgrade");
if (knowledgeEvaluationUpgradeIntegration && (!process.env.E2E_KNOWLEDGE_EVALUATION_LEGACY_SOURCE || !isAbsolute(process.env.E2E_KNOWLEDGE_EVALUATION_LEGACY_SOURCE))) throw new Error("Actual original166 source required for knowledge evaluation upgrade");
const factoryErpVoidReviewAny = factoryErpVoidReviewIntegration || factoryErpVoidReviewUpgradeIntegration || factoryErpVoidReviewBrowser;
process.env.E2E_FACTORY_ERP_VOID_REVIEW_ISOLATED = factoryErpVoidReviewAny ? "1" : "0";
if (factoryErpVoidReviewUpgradeIntegration && (!process.env.E2E_FACTORY_ERP_VOID_REVIEW_LEGACY_SOURCE || !isAbsolute(process.env.E2E_FACTORY_ERP_VOID_REVIEW_LEGACY_SOURCE))) throw new Error("Original165 source required for factory void review upgrade");
process.env.E2E_FACTORY_ERP_BINDING_ISOLATED = factoryErpVoidReviewAny || factoryErpBindingIntegration || factoryErpBindingUpgradeIntegration || factoryErpBindingBrowser ? "1" : "0";
if (factoryErpBindingUpgradeIntegration && (!process.env.E2E_FACTORY_ERP_BINDING_LEGACY_SOURCE || !isAbsolute(process.env.E2E_FACTORY_ERP_BINDING_LEGACY_SOURCE))) throw new Error("Original164 source required for factory binding upgrade");
process.env.E2E_FACTORY_ERP_SOURCE_RETENTION_ISOLATED = factoryErpVoidReviewAny || factoryErpBindingIntegration || factoryErpBindingUpgradeIntegration || factoryErpBindingBrowser || factoryErpSourceRetentionIntegration || factoryErpSourceRetentionUpgradeIntegration || factoryErpSourceRetentionBrowser ? "1" : "0";
process.env.E2E_FACTORY_ERP_IMPORT_ISOLATED = anyAgentTools || factoryErpVoidReviewAny || factoryErpBindingIntegration || factoryErpBindingUpgradeIntegration || factoryErpBindingBrowser || factoryErpImportIntegration || factoryErpImportUpgradeIntegration || factoryErpImportBrowser || factoryErpSourceRetentionIntegration || factoryErpSourceRetentionUpgradeIntegration || factoryErpSourceRetentionBrowser ? "1" : "0";
if (anyAgentFulfillment) for (const flag of ["E2E_AGENT_FULFILLMENT_ISOLATED", "E2E_FACTORY_ERP_IMPORT_ISOLATED", "E2E_AGENT_RESOURCES_ISOLATED", "E2E_AGENT_READ_ISOLATED", "E2E_ROLE_BENCHMARK_ISOLATED", "E2E_KNOWLEDGE_EVALUATION_ISOLATED"]) process.env[flag] = "1";
if (factoryErpSourceRetentionUpgradeIntegration && (!process.env.E2E_FACTORY_ERP_SOURCE_RETENTION_LEGACY_SOURCE || !isAbsolute(process.env.E2E_FACTORY_ERP_SOURCE_RETENTION_LEGACY_SOURCE)))
  throw new Error("Original163 source required for factory source retention upgrade");
if (factoryErpImportUpgradeIntegration && (!process.env.E2E_FACTORY_ERP_IMPORT_LEGACY_SOURCE || !isAbsolute(process.env.E2E_FACTORY_ERP_IMPORT_LEGACY_SOURCE)))
  throw new Error("Original162 source required for factory ERP import upgrade");
process.env.E2E_QUALITY_SCRAP_ISOLATED = qualityScrapIntegration || qualityScrapUpgradeIntegration || qualityScrapBrowser ? "1" : "0";
const qualityScrapApiPort = qualityScrapBrowser ? await disposableAdvertisingApiPort() : null;
if (qualityScrapApiPort) process.env.E2E_QUALITY_SCRAP_API_PORT = String(qualityScrapApiPort);
Object.assign(manifest, { qualityScrapApiPort });
if (qualityScrapUpgradeIntegration && (!process.env.E2E_QUALITY_SCRAP_LEGACY_SOURCE || !isAbsolute(process.env.E2E_QUALITY_SCRAP_LEGACY_SOURCE))) throw new Error("Actual original160 source required for quality scrap upgrade");
process.env.E2E_PRODUCTION_QUANTITY_ISOLATED = productionQuantityIntegration || productionQuantityUpgradeIntegration || productionStopBrowser || qualityScrapIntegration || qualityScrapUpgradeIntegration || qualityScrapBrowser ? "1" : "0";
const productionStopApiPort = productionStopBrowser ? await disposableAdvertisingApiPort() : null;
if (productionStopApiPort) process.env.E2E_PRODUCTION_STOP_API_PORT = String(productionStopApiPort);
Object.assign(manifest, { productionStopApiPort });
process.env.E2E_FACTORY_CAPACITY_ISOLATED = factoryCapacityIntegration || factoryCapacityUpgradeIntegration || factoryCapacityBrowser || productionStopBrowser || qualityScrapBrowser ? "1" : "0";
const factoryCapacityApiPort = factoryCapacityBrowser ? await disposableAdvertisingApiPort() : null;
if (factoryCapacityApiPort) process.env.E2E_FACTORY_CAPACITY_API_PORT = String(factoryCapacityApiPort);
Object.assign(manifest, { factoryCapacityApiPort });
process.env.E2E_FACTORY_AUTHORITY_ISOLATED = factoryAuthorityIntegration || factoryAuthorityBrowser ? "1" : "0";
const factoryAuthorityApiPort = factoryAuthorityBrowser ? await disposableAdvertisingApiPort() : null;
if (factoryAuthorityApiPort) process.env.E2E_FACTORY_AUTHORITY_API_PORT = String(factoryAuthorityApiPort);
Object.assign(manifest, { factoryAuthorityApiPort });
process.env.E2E_ADVERTISING_COMMAND_ISOLATED = advertisingCommandIntegration || advertisingCommandBrowser ? "1" : "0";
if(advertisingCommandIntegration||advertisingCommandBrowser)process.env.ADVERTISING_COMMAND_ENCRYPTION_KEY=randomBytes(32).toString("base64url");
const advertisingCommandApiPort=advertisingCommandBrowser?await disposableAdvertisingApiPort():null;
if(advertisingCommandApiPort)process.env.E2E_ADVERTISING_COMMAND_API_PORT=String(advertisingCommandApiPort);
Object.assign(manifest,{advertisingCommandApiPort});
async function disposableAdvertisingApiPort():Promise<number>{
  for(let attempt=0;attempt<10;attempt++){
    const port=await new Promise<number>((resolve,reject)=>{const server=createServer();server.once("error",reject);server.listen(0,"127.0.0.1",()=>{
      const address=server.address();if(!address||typeof address==="string"){server.close();reject(new Error("Disposable port unavailable"));return;}
      server.close(error=>error?reject(error):resolve(address.port));
    });});
    if(port>1024&&![3000,8000,4177,3130,8130].includes(port))return port;
  }
  throw new Error("Dedicated disposable advertising port unavailable");
}
const advertisingHistoryIntegration = process.argv.includes("--suite=advertising-history-integration");
const advertisingHistoryBrowser = process.argv.includes("--suite=advertising-history-browser");
process.env.E2E_ADVERTISING_HISTORY_ISOLATED = advertisingHistoryIntegration || advertisingHistoryBrowser ? "1" : "0";
const advertisingMeasurementIntegration = process.argv.includes("--suite=advertising-measurement-integration");
const advertisingMeasurementBrowser = process.argv.includes("--suite=advertising-measurement-browser");
process.env.E2E_ADVERTISING_MEASUREMENT_ISOLATED = advertisingMeasurementIntegration || advertisingMeasurementBrowser ? "1" : "0";
if (advertisingMeasurementIntegration || advertisingMeasurementBrowser) process.env.E2E_ADVERTISING_MEASUREMENT_LEGACY_SOURCE = fileURLToPath(new URL("../../.artifacts/ordinary-api-source-148-41d9bb72/", import.meta.url));
const advertisingAuthorityIntegration = process.argv.includes("--suite=advertising-authority-integration");
const advertisingAuthorityBrowser = process.argv.includes("--suite=advertising-authority-browser");
process.env.E2E_ADVERTISING_AUTHORITY_ISOLATED = advertisingAuthorityIntegration || advertisingAuthorityBrowser ? "1" : "0";
const financeCommandReadLockIntegration = process.argv.includes("--suite=finance-command-read-lock-integration");
const financeCommandGuardIntegration = process.argv.includes("--suite=finance-command-guard-integration");
const financeCommandIntegration = process.argv.includes("--suite=finance-command-integration") || financeCommandBusinessIntegration || financeCommandGuardIntegration || financeCommandReadLockIntegration || financeCommandResultIntegration;
const financeCommandProcessIntegration = process.argv.includes("--suite=finance-command-process-integration");
const financeCommandUpgradeIntegration = process.argv.includes("--suite=finance-command-upgrade-integration");
const financeCommandBrowser = process.argv.includes("--suite=finance-command-browser") || financeCommandResultBrowser;
const financeCommandRelated = financeCommandIntegration || financeCommandProcessIntegration || financeCommandUpgradeIntegration || financeCommandBrowser;
process.env.E2E_FINANCE_COMMAND_ISOLATED = financeCommandRelated ? "1" : "0";
process.env.E2E_FINANCE_COMMAND_PROCESS_ISOLATED = financeCommandProcessIntegration ? "1" : "0";
process.env.E2E_FINANCE_COMMAND_RESULT_ISOLATED = financeCommandResultIntegration || financeCommandResultBrowser ? "1" : "0";
if (financeCommandRelated) process.env.FINANCE_COMMAND_ENCRYPTION_KEY = randomBytes(32).toString("base64url");
if (financeCommandUpgradeIntegration && (!process.env.E2E_FINANCE_COMMAND_LEGACY_SOURCE || !isAbsolute(process.env.E2E_FINANCE_COMMAND_LEGACY_SOURCE)))
 throw new Error("Original156 source required for finance command upgrade");
const financeCostAllocationIntegration = process.argv.includes("--suite=finance-cost-allocation-integration");
const financeCostAllocationUpgradeIntegration = process.argv.includes("--suite=finance-cost-allocation-upgrade-integration");
const financeCostAllocationBrowser = process.argv.includes("--suite=finance-cost-allocation-browser");
const orderProfitReviewBrowser = process.argv.includes("--suite=order-profit-review-browser");
process.env.E2E_ORDER_PROFIT_REVIEW_ISOLATED = orderProfitReviewBrowser ? "1" : "0";
process.env.E2E_FINANCE_COST_ALLOCATION_ISOLATED = financeCommandRelated || financeCostAllocationIntegration || financeCostAllocationUpgradeIntegration || financeCostAllocationBrowser ? "1" : "0";
if (financeCostAllocationUpgradeIntegration && (!process.env.E2E_FINANCE_COST_ALLOCATION_LEGACY_SOURCE || !isAbsolute(process.env.E2E_FINANCE_COST_ALLOCATION_LEGACY_SOURCE)))
 throw new Error("Original155 source required for finance cost allocation upgrade");
const financeLedgerIntegration = process.argv.includes("--suite=finance-ledger-integration");
const financeLedgerBrowser = process.argv.includes("--suite=finance-ledger-browser");
process.env.E2E_FINANCE_LEDGER_ISOLATED = financeLedgerIntegration || financeLedgerBrowser ? "1" : "0";
const financePayablesAdjustmentsIntegration = process.argv.includes("--suite=finance-payables-adjustments-integration");
const financePayablesAdjustmentsUpgradeIntegration = process.argv.includes("--suite=finance-payables-adjustments-upgrade-integration");
const financePayablesAdjustmentsBrowser = process.argv.includes("--suite=finance-payables-adjustments-browser");
process.env.E2E_FINANCE_PAYABLES_ADJUSTMENTS_ISOLATED = financeCommandRelated || financeLedgerIntegration || financeLedgerBrowser || financePayablesAdjustmentsIntegration || financePayablesAdjustmentsUpgradeIntegration || financePayablesAdjustmentsBrowser ? "1" : "0";
if (financePayablesAdjustmentsUpgradeIntegration && (!process.env.E2E_FINANCE_PAYABLES_ADJUSTMENTS_LEGACY_SOURCE || !isAbsolute(process.env.E2E_FINANCE_PAYABLES_ADJUSTMENTS_LEGACY_SOURCE)))
 throw new Error("Original154 source required for finance payables adjustment upgrade");
const financeAuthorityIntegration = process.argv.includes("--suite=finance-authority-integration");
const financeAuthorityUpgradeIntegration = process.argv.includes("--suite=finance-authority-upgrade-integration");
const financeAuthorityBrowser = process.argv.includes("--suite=finance-authority-browser");
process.env.E2E_FINANCE_AUTHORITY_ISOLATED = financeAuthorityIntegration || financeAuthorityUpgradeIntegration || financeAuthorityBrowser ? "1" : "0";
if (financeAuthorityUpgradeIntegration && (!process.env.E2E_FINANCE_AUTHORITY_LEGACY_SOURCE || !isAbsolute(process.env.E2E_FINANCE_AUTHORITY_LEGACY_SOURCE)))
 throw new Error("Original153 source required for finance authority upgrade");
const financePayablesIntegration = process.argv.includes("--suite=finance-payables-integration");
const financePayablesUpgradeIntegration = process.argv.includes("--suite=finance-payables-upgrade-integration");
const financePayablesBrowser = process.argv.includes("--suite=finance-payables-browser");
process.env.E2E_FINANCE_PAYABLES_ISOLATED = financeCommandRelated || financeLedgerIntegration || financeLedgerBrowser || financePayablesAdjustmentsIntegration || financePayablesAdjustmentsUpgradeIntegration || financePayablesAdjustmentsBrowser || financePayablesIntegration || financePayablesUpgradeIntegration || financePayablesBrowser ? "1" : "0";
if (financePayablesUpgradeIntegration && (!process.env.E2E_FINANCE_PAYABLES_LEGACY_SOURCE || !isAbsolute(process.env.E2E_FINANCE_PAYABLES_LEGACY_SOURCE)))
 throw new Error("Original152 source required for finance payables upgrade");
const financeMonetaryUpgradeIntegration = process.argv.includes("--suite=finance-monetary-upgrade-integration");
const financeMonetaryRelatedIntegration = process.argv.includes("--suite=finance-monetary-related-integration");
const financeMonetaryBrowser = process.argv.includes("--suite=finance-monetary-browser");
process.env.E2E_FINANCE_MONETARY_ISOLATED = financeCommandRelated || financeCostAllocationIntegration || financeCostAllocationUpgradeIntegration || financeCostAllocationBrowser || financeAuthorityIntegration || financeAuthorityUpgradeIntegration || financeAuthorityBrowser || financeMonetaryIntegration || financeMonetaryUpgradeIntegration || financeMonetaryRelatedIntegration || financeMonetaryBrowser ? "1" : "0";
if (financeMonetaryUpgradeIntegration && (!process.env.E2E_FINANCE_MONETARY_LEGACY_SOURCE || !isAbsolute(process.env.E2E_FINANCE_MONETARY_LEGACY_SOURCE)))
 throw new Error("Original151 source required for finance monetary upgrade");
const invoiceReconciliationIntegration = process.argv.includes("--suite=invoice-reconciliation-integration");
const invoiceReconciliationUpgradeIntegration = process.argv.includes("--suite=invoice-reconciliation-upgrade-integration");
const invoiceReconciliationBrowser = process.argv.includes("--suite=invoice-reconciliation-browser");
process.env.E2E_INVOICE_RECONCILIATION_ISOLATED = financeCommandRelated || financeLedgerIntegration || financeLedgerBrowser || financePayablesAdjustmentsIntegration || financePayablesAdjustmentsUpgradeIntegration || financePayablesAdjustmentsBrowser || invoiceReconciliationIntegration || invoiceReconciliationUpgradeIntegration || invoiceReconciliationBrowser ? "1" : "0";
if (invoiceReconciliationUpgradeIntegration && (!process.env.E2E_INVOICE_RECONCILIATION_LEGACY_SOURCE || !isAbsolute(process.env.E2E_INVOICE_RECONCILIATION_LEGACY_SOURCE)))
 throw new Error("Original150 source required for invoice reconciliation upgrade");
const invoiceCommandIntegration = process.argv.includes("--suite=invoice-command-integration");
const invoiceCommandUpgradeIntegration = process.argv.includes("--suite=invoice-command-upgrade-integration");
const invoiceCommandBrowser = process.argv.includes("--suite=invoice-command-browser");
process.env.E2E_INVOICE_COMMAND_ISOLATED = anyAgentDependencyPlan || invoiceCommandIntegration || invoiceCommandUpgradeIntegration || invoiceCommandBrowser ? "1" : "0";
if (invoiceCommandUpgradeIntegration) {
  const legacy = process.env.E2E_INVOICE_COMMAND_LEGACY_SOURCE;
  if (!legacy || !isAbsolute(legacy)) throw new Error("Original149 source required for invoice command upgrade");
}
const procurementPrecisionIntegration = process.argv.includes("--suite=procurement-precision-integration");
const procurementPrecisionUpgradeIntegration = process.argv.includes("--suite=procurement-precision-upgrade-integration");
const procurementPrecisionBrowser = process.argv.includes("--suite=procurement-precision-browser");
const incomingInspectionIntegration = process.argv.includes("--suite=incoming-inspection-integration");
const incomingProcessIntegration = process.argv.includes("--suite=incoming-process-integration");
const procurementProcessIntegration = process.argv.includes("--suite=procurement-process-integration");
process.env.E2E_INCOMING_PROCESS_ISOLATED = incomingProcessIntegration ? "1" : "0";
process.env.E2E_PROCUREMENT_PROCESS_ISOLATED = anyAgentDependencyPlan || procurementProcessIntegration || procurementPrecisionIntegration || invoiceCommandIntegration || invoiceReconciliationIntegration ? "1" : "0";
process.env.E2E_PROCUREMENT_PRECISION_ISOLATED = procurementPrecisionIntegration || procurementPrecisionUpgradeIntegration || procurementPrecisionBrowser ? "1" : "0";
if (procurementPrecisionUpgradeIntegration) process.env.E2E_PROCUREMENT_PRECISION_LEGACY_SOURCE = fileURLToPath(new URL("../../.artifacts/ordinary-api-source-148-41d9bb72/", import.meta.url));
process.env.E2E_LEGACY_SCHEMA_TARGET = agentNativeV4UpgradeIntegration ? "pre-0187" : agentFulfillmentCommandUpgradeIntegration ? "pre-0186" : fulfillmentCommandUpgradeIntegration ? "pre-0185" : agentDependencyPlanUpgradeIntegration ? "pre-0184" : publicationNodeSubmitUpgradeIntegration ? "pre-0183" : publicationNodePreviewUpgradeIntegration ? "pre-0182" : listingSyncIntentUpgradeIntegration ? "pre-0181" : storeNodeExecutionUpgradeIntegration ? "pre-0180" : storeNodeIdentityUpgradeIntegration ? "pre-0179" : marketplaceAuthorityUpgradeIntegration ? "pre-0178" : agentNativeV3UpgradeIntegration ? "pre-0177" : agentNativeV2UpgradeIntegration ? "pre-0176" : agentNativeUpgradeIntegration ? "pre-0175" : agentPlanUpgradeIntegration ? "pre-0174" : agentCommandUpgradeIntegration ? "pre-0173" : agentLoopUpgradeIntegration ? "pre-0172" : agentDelegationUpgradeIntegration ? "pre-0171" : roleBenchmarkUpgradeIntegration ? "pre-0170" : businessBenchmarkUpgradeIntegration ? "pre-0169" : knowledgeBenchmarkUpgradeIntegration ? "pre-0168" : knowledgeEvaluationUpgradeIntegration ? "pre-0167" : factoryErpVoidReviewUpgradeIntegration ? "pre-0166" : factoryErpBindingUpgradeIntegration ? "pre-0165" : factoryErpSourceRetentionUpgradeIntegration ? "pre-0164" : factoryErpImportUpgradeIntegration ? "pre-0163" : qualityScrapUpgradeIntegration ? "pre-0161" : productionQuantityUpgradeIntegration ? "pre-0160" : factoryCapacityUpgradeIntegration ? "pre-0159" : financeCommandUpgradeIntegration ? "pre-0157" : financeCostAllocationUpgradeIntegration ? "pre-0156" : financePayablesAdjustmentsUpgradeIntegration ? "pre-0155" : financeAuthorityUpgradeIntegration ? "pre-0154" : financePayablesUpgradeIntegration ? "pre-0153" : financeMonetaryUpgradeIntegration ? "pre-0152" : invoiceReconciliationUpgradeIntegration ? "pre-0151" : invoiceCommandUpgradeIntegration ? "pre-0150" : procurementPrecisionUpgradeIntegration ? "pre-0149" : procurementUpgradeIntegration ? "pre-0146" : incomingUpgradeIntegration ? "pre-0143" : receiptRequestUpgradeIntegration ? "pre-0142" : inventoryUpgradeIntegration ? "pre-0138" : shiposUpgradeIntegration ? "pre-0137" : manufacturingDeliveryUpgradeIntegration ? "pre-0135" : manufacturingUpgradeIntegration ? "pre-0134" : qualityGroupsUpgradeIntegration ? "pre-0132" : shipmentUpgradeIntegration ? "pre-0131" : qualityUpgradeIntegration ? "pre-0130" : "current";
const shiposIntegration = process.argv.includes("--suite=shipos-integration") || shiposUpgradeIntegration,
  shipos = process.argv.includes("--suite=shipos");
const inventoryIntegration = process.argv.includes("--suite=inventory-integration") || inventoryUpgradeIntegration || receiptRequestUpgradeIntegration || incomingInspectionIntegration || incomingProcessIntegration || procurementProcessIntegration || incomingUpgradeIntegration || procurementUpgradeIntegration || procurementPrecisionIntegration || procurementPrecisionUpgradeIntegration || invoiceCommandIntegration || invoiceCommandUpgradeIntegration || invoiceReconciliationIntegration || invoiceReconciliationUpgradeIntegration;
let shiposFixture: Awaited<ReturnType<typeof startShiposFixtureServer>> | undefined;
let logisticsFixture: Awaited<ReturnType<typeof startLogisticsFixtureServer>> | undefined;
let knowledgeSandbox: Awaited<ReturnType<typeof createKnowledgeBrowserSandbox>> | undefined;
let studioRuntime: Awaited<ReturnType<typeof startSealedStudioRuntime>> | undefined;
const factoryPortal = process.argv.includes("--suite=factory-portal"),
  ordinaryDailyBrowser = !process.argv.some(argument => argument.startsWith("--suite=")) || process.argv.includes("--suite=order-daily"),
  productionCommandRestart = process.argv.includes("--suite=production-command-restart"),
  factoryCollaboration = process.argv.includes("--suite=factory-collaboration"),
  productAccessBrowser = process.argv.includes("--suite=product-access"),
  listingAuthorityBrowser = process.argv.includes("--suite=listing-authority"),
  salesPlanSessionBrowser = process.argv.includes("--suite=sales-plan-session"),
  salesPlanReferencesBrowser = process.argv.includes("--suite=sales-plan-references"),
  salesPackageHistoryBrowser = process.argv.includes("--suite=sales-package-history"),
  channelMappingBrowser = process.argv.includes("--suite=channel-mapping"),
  salesEditorLifecycleBrowser = process.argv.includes("--suite=sales-editor-lifecycle"),
  salesCompositionBrowser = process.argv.includes("--suite=sales-composition") || salesEditorLifecycleBrowser,
  catalogEditorBrowser = process.argv.includes("--suite=catalog-editor"),
  specificationFactsBrowser = process.argv.includes("--suite=specification-facts"),
  qualityAssessmentBrowser = process.argv.includes("--suite=quality-assessment"),
  manufacturingBrowser = process.argv.includes("--suite=manufacturing"),
  productionHandoffBrowser = process.argv.includes("--suite=production-handoff"),
  productionDeliveryBrowser = process.argv.includes("--suite=production-delivery"),
  teamBrowser = process.argv.includes("--suite=teams"),
  compiledWeb = process.argv.includes("--compiled-web"),
  incomingBrowser = process.argv.includes("--suite=incoming-browser"),
  procurementCycleBrowser = process.argv.includes("--suite=procurement-cycle-browser"),
  erpPersonalBrowser =
    ordinaryDailyBrowser ||
    studioPersonalBrowser ||
    shipmentCreateBrowser ||
    agentNativeV4Browser || agentFulfillmentCommandBrowser || orderSummaryBrowser || fulfillmentCommandBrowser || agentDependencyPlanBrowser || agentRuntimeReadinessBrowser || agentMcpReadinessBrowser || agentReadinessBrowser || publicationNodeSubmitBrowser || amazonPublicNodeBrowser || publicationAuthorityBrowser || publicationNodePreviewBrowser || listingSyncIntentBrowser || storeNodeExecutionBrowser || storeNodeIdentityBrowser || marketplaceAuthorityBrowser || agentMcpV2Browser || agentNativeV3Browser || agentFulfillmentBrowser || agentNativeV2Browser || agentResourcesBrowser || agentMcpBrowser || agentNativeBrowser || agentToolsBrowser || agentPlanBrowser || agentCommandBrowser || agentLoopBrowser || agentEntryBrowser || agentReadBrowser || agentDelegationBrowser || roleBenchmarkBrowser || businessBenchmarkBrowser || knowledgeBenchmarkBrowser ||
    knowledgeEvaluationBrowser ||
    factoryErpVoidReviewBrowser ||
    factoryErpBindingBrowser ||
    factoryErpImportBrowser ||
    factoryErpSourceRetentionBrowser ||
    qualityScrapBrowser || productionStopBrowser || factoryCapacityBrowser || factoryAuthorityBrowser || advertisingCommandBrowser || advertisingHistoryBrowser || advertisingMeasurementBrowser || advertisingAuthorityBrowser || orderProfitReviewBrowser || financeCommandBrowser ||
    financeCostAllocationBrowser ||
    financeLedgerBrowser ||
    financePayablesAdjustmentsBrowser ||
    financeAuthorityBrowser ||
    financePayablesBrowser ||
    financeMonetaryBrowser ||
    invoiceReconciliationBrowser ||
    invoiceCommandBrowser ||
    procurementPrecisionBrowser ||
    procurementCycleBrowser ||
    incomingBrowser ||
    shipos ||
    productionCommandRestart ||
    teamBrowser ||
    productAccessBrowser ||
    listingAuthorityBrowser ||
    salesPlanSessionBrowser ||
    salesPlanReferencesBrowser ||
    salesPackageHistoryBrowser ||
    channelMappingBrowser ||
    salesCompositionBrowser ||
    catalogEditorBrowser ||
    specificationFactsBrowser ||
    qualityAssessmentBrowser ||
    manufacturingBrowser ||
    productionHandoffBrowser ||
    productionDeliveryBrowser ||
    process.argv.includes("--suite=factory-directory") ||
    process.argv.includes("--suite=erp-identity");
process.env.WEB_AUTH_MODE = erpPersonalBrowser ? "personal" : "local-service";
if (procurementCycleBrowser || procurementPrecisionBrowser || invoiceCommandBrowser || invoiceReconciliationBrowser) process.env.E2E_REAL_PRODUCTS = "1";
let factoryIdentity: Awaited<ReturnType<typeof startFactoryIdentityFixture>> | Awaited<ReturnType<typeof startAgentMcpBrowserIdentityFixture>> | undefined;
let webCandidate: Awaited<ReturnType<typeof verifyLocalWebCandidate>> | undefined;
let earlyRedisPort: string | undefined;
function startDisposableRedis() {
  execFileSync("docker", ["run", "--detach", "--rm", "--name", redis, "--publish", "127.0.0.1::6379", "redis:8-alpine"], { stdio: "pipe", windowsHide: true });
  const value = execFileSync("docker", ["port", redis, "6379/tcp"], { encoding: "utf8", windowsHide: true }).trim().split(":").at(-1)!;
  if (!/^\d+$/.test(value)) throw new Error("Disposable Redis port unavailable");
  return value;
}
try {
  if ((agentNativeV4Browser || shipmentCreateBrowser || studioPersonalBrowser) && (!compiledWeb || !webCandidateId))
    throw Error("NativeV4 browser requires an explicit verified compiled Web candidate");
  if (webCandidateId && !compiledWeb)
    throw Error("A Web candidate requires explicit compiled browser mode");
  if (compiledWeb && !erpPersonalBrowser)
    throw Error("Compiled browser mode requires an ERP personal-identity suite");
  if (anyAgentTools || roleBenchmarkAny || factoryErpVoidReviewAny || factoryErpBindingIntegration || factoryErpBindingUpgradeIntegration || factoryErpBindingBrowser || factoryErpImportIntegration || factoryErpImportUpgradeIntegration || factoryErpImportBrowser || factoryErpSourceRetentionIntegration || factoryErpSourceRetentionUpgradeIntegration || factoryErpSourceRetentionBrowser || orderProfitReviewBrowser || factoryCapacityBrowser || productionStopBrowser || qualityScrapBrowser) {
    // Fail before creating business fixtures. This suite uploads real synthetic
    // bytes through the real scanner; other finance suites do not prove it works.
    let scan;
    try {
      scan = await new ClamAvScanner().scan({ body: Buffer.from("Synthetic order review prerequisite check"),
        fileName: "synthetic-prerequisite.txt", mediaType: "text/plain" });
    } catch { throw new Error("File-scanning prerequisite: scanner unavailable"); }
    if (scan.result !== "clean" || scan.signatureVersion === "unavailable")
      throw new Error("File-scanning prerequisite: scanner rejected the synthetic check");
    manifest.fileScannerEvidence = { engine: scan.engine, signatureVersion: scan.signatureVersion, result: "clean" };
  }
  if (erpPersonalBrowser || factoryPortal || factoryCollaboration) {
    manifest.browserMode = productionCommandRestart ? "isolated_api_restart" : compiledWeb ? "compiled" : "isolated_dev";
  }
  if (erpPersonalBrowser) {
    process.env.E2E_COMPILED_WEB = compiledWeb ? "1" : "0";
  }
  if (compiledWeb) {
    if (webCandidateId) {
      webCandidate = await verifyLocalWebCandidate(fileURLToPath(new URL("../../", import.meta.url)), webCandidateId);
      manifest.webBuildId = webCandidate.manifest.buildId;
    } else {
      manifest.webBuildId = (
        await readFile(new URL("../../apps/web/.next/BUILD_ID", import.meta.url), "utf8")
      ).trim();
    }
    if (!manifest.webBuildId) throw Error("A current production Web build is required");
  }
  if (studioPersonalBrowser) {
    const runtimeManifest = process.env.E2E_STUDIO_RUNTIME_MANIFEST;
    if (!runtimeManifest || !isAbsolute(runtimeManifest) || !webCandidate) throw Error("An explicit sealed Studio artifact and compiled candidate are required");
    const runtime = await verifyStudioRuntime(runtimeManifest);
    if (runtime.manifest.sourceStamp !== await canvasRuntimeSourceStamp()) throw Error("Studio artifact does not match the frozen current runtime source");
    const { captureRuntimeSource } = await import("./database-upgrade.mts");
    const source = await captureRuntimeSource(fileURLToPath(new URL("../../", import.meta.url)));
    if (source.sha256 !== webCandidate.manifest.sourceSha256) throw Error("Studio browser API/Web must use the same frozen source candidate");
    studioRuntime = await startSealedStudioRuntime({ manifestPath: runtime.manifestPath, host: "127.0.0.1", port: 4316,
      parentOrigins: ["http://localhost:3130", "http://127.0.0.1:3130"] });
    manifest.studioRuntime = { bundleId: runtime.id, sourceStamp: runtime.manifest.sourceStamp, closed: false };
  }
  await admin.client.unsafe(`CREATE DATABASE ${name}`);
  const fixture = connectDatabase(testUrl.toString());
  try {
    if (agentNativeV4UpgradeIntegration) {
      earlyRedisPort = startDisposableRedis();
      const { migrateAgentNativeV4LegacyDatabase } = await import("../testing/agent-native-v4-legacy.mts");
      await migrateAgentNativeV4LegacyDatabase(fixture, name, { ...process.env, DATABASE_URL: testUrl.toString(), S3_PRIVATE_BUCKET: bucket,
        E2E_ISOLATED_DAILY: "1", REDIS_URL: "redis://127.0.0.1:" + earlyRedisPort,
        E2E_DISPOSABLE_REDIS_URL: "redis://127.0.0.1:" + earlyRedisPort, E2E_DISPOSABLE_REDIS_CONTAINER: redis });
    }
    else if (agentFulfillmentCommandUpgradeIntegration) {
      earlyRedisPort = startDisposableRedis();
      const { migrateAgentFulfillmentCommandLegacyDatabase } = await import("../testing/agent-fulfillment-command-legacy.mts");
      await migrateAgentFulfillmentCommandLegacyDatabase(fixture, name, { ...process.env, DATABASE_URL: testUrl.toString(), S3_PRIVATE_BUCKET: bucket,
        E2E_ISOLATED_DAILY: "1", REDIS_URL: "redis://127.0.0.1:" + earlyRedisPort,
        E2E_DISPOSABLE_REDIS_URL: "redis://127.0.0.1:" + earlyRedisPort, E2E_DISPOSABLE_REDIS_CONTAINER: redis });
    }
    else if (fulfillmentCommandUpgradeIntegration) {
      earlyRedisPort = startDisposableRedis();
      const { migrateFulfillmentCommandLegacyDatabase } = await import("../testing/fulfillment-command-legacy.mts");
      await migrateFulfillmentCommandLegacyDatabase(fixture, name, { ...process.env, DATABASE_URL: testUrl.toString(), S3_PRIVATE_BUCKET: bucket,
        E2E_ISOLATED_DAILY: "1", REDIS_URL: "redis://127.0.0.1:" + earlyRedisPort,
        E2E_DISPOSABLE_REDIS_URL: "redis://127.0.0.1:" + earlyRedisPort, E2E_DISPOSABLE_REDIS_CONTAINER: redis });
    }
    else if (agentDependencyPlanUpgradeIntegration) {
      earlyRedisPort = startDisposableRedis();
      const { migrateAgentDependencyPlanLegacyDatabase } = await import("../testing/agent-dependency-plan-legacy.mts");
      await migrateAgentDependencyPlanLegacyDatabase(fixture, name, { ...process.env, DATABASE_URL: testUrl.toString(), S3_PRIVATE_BUCKET: bucket,
        E2E_ISOLATED_DAILY: "1", REDIS_URL: "redis://127.0.0.1:" + earlyRedisPort,
        E2E_DISPOSABLE_REDIS_URL: "redis://127.0.0.1:" + earlyRedisPort, E2E_DISPOSABLE_REDIS_CONTAINER: redis });
    }
    else if(publicationNodeSubmitUpgradeIntegration){
      earlyRedisPort=startDisposableRedis();
      const {migratePublicationNodeSubmitLegacyDatabase}=await import("../../apps/api/src/marketplaces/publication-node-submit-graph.test-fixture.js");
      await migratePublicationNodeSubmitLegacyDatabase(fixture,name,{...process.env,DATABASE_URL:testUrl.toString(),S3_PRIVATE_BUCKET:bucket,E2E_ISOLATED_DAILY:"1",
        REDIS_URL:"redis://127.0.0.1:"+earlyRedisPort,E2E_DISPOSABLE_REDIS_URL:"redis://127.0.0.1:"+earlyRedisPort,E2E_DISPOSABLE_REDIS_CONTAINER:redis});
    }
    else if (publicationNodePreviewUpgradeIntegration) {
      earlyRedisPort=startDisposableRedis();
      const {migratePublicationNodePreviewLegacyDatabase}=await import("../../apps/api/src/marketplaces/publication-node-preview-graph.test-fixture.js");
      await migratePublicationNodePreviewLegacyDatabase(fixture,name,{...process.env,DATABASE_URL:testUrl.toString(),S3_PRIVATE_BUCKET:bucket,E2E_ISOLATED_DAILY:"1",
        REDIS_URL:"redis://127.0.0.1:"+earlyRedisPort,E2E_DISPOSABLE_REDIS_URL:"redis://127.0.0.1:"+earlyRedisPort,E2E_DISPOSABLE_REDIS_CONTAINER:redis});
    }
    else if (listingSyncIntentUpgradeIntegration) {
      earlyRedisPort = startDisposableRedis();
      const { migrateListingSyncIntentLegacyDatabase } = await import("../../apps/api/src/marketplaces/listing-sync-intent-graph.test-fixture.js");
      await migrateListingSyncIntentLegacyDatabase(fixture, name, { ...process.env,
        DATABASE_URL: testUrl.toString(), S3_PRIVATE_BUCKET: bucket, E2E_ISOLATED_DAILY: "1",
        REDIS_URL: "redis://127.0.0.1:" + earlyRedisPort, E2E_DISPOSABLE_REDIS_URL: "redis://127.0.0.1:" + earlyRedisPort,
        E2E_DISPOSABLE_REDIS_CONTAINER: redis });
    }
    else if (storeNodeExecutionUpgradeIntegration) {
      earlyRedisPort = startDisposableRedis();
      const { migrateStoreNodeExecutionLegacyDatabase } = await import("../../apps/api/src/marketplaces/store-node-execution-graph.test-fixture.js");
      await migrateStoreNodeExecutionLegacyDatabase(fixture, name, { ...process.env,
        DATABASE_URL: testUrl.toString(), S3_PRIVATE_BUCKET: bucket, E2E_ISOLATED_DAILY: "1",
        REDIS_URL: "redis://127.0.0.1:" + earlyRedisPort, E2E_DISPOSABLE_REDIS_URL: "redis://127.0.0.1:" + earlyRedisPort,
        E2E_DISPOSABLE_REDIS_CONTAINER: redis });
    }
    else if (storeNodeIdentityUpgradeIntegration) {
      earlyRedisPort = startDisposableRedis();
      const { migrateStoreNodeIdentityLegacyDatabase } = await import("../../apps/api/src/marketplaces/store-node-identity.test-fixture.js");
      await migrateStoreNodeIdentityLegacyDatabase(fixture, name, { ...process.env,
        DATABASE_URL: testUrl.toString(), S3_PRIVATE_BUCKET: bucket, E2E_ISOLATED_DAILY: "1",
        REDIS_URL: "redis://127.0.0.1:" + earlyRedisPort, E2E_DISPOSABLE_REDIS_URL: "redis://127.0.0.1:" + earlyRedisPort,
        E2E_DISPOSABLE_REDIS_CONTAINER: redis });
    }
    else if (marketplaceAuthorityUpgradeIntegration) {
      earlyRedisPort = startDisposableRedis();
      await migrateMarketplaceAuthorityLegacyDatabase(fixture, name, { ...process.env,
        DATABASE_URL: testUrl.toString(), S3_PRIVATE_BUCKET: bucket, E2E_ISOLATED_DAILY: "1",
        REDIS_URL: "redis://127.0.0.1:" + earlyRedisPort, E2E_DISPOSABLE_REDIS_URL: "redis://127.0.0.1:" + earlyRedisPort,
        E2E_DISPOSABLE_REDIS_CONTAINER: redis });
    }
    else if(agentNativeV3UpgradeIntegration){
      earlyRedisPort=startDisposableRedis();
      await migrateAgentNativeV3LegacyDatabase(fixture,name,{
        ...process.env,DATABASE_URL:testUrl.toString(),S3_PRIVATE_BUCKET:bucket,E2E_ISOLATED_DAILY:"1",
        REDIS_URL:"redis://127.0.0.1:"+earlyRedisPort,E2E_DISPOSABLE_REDIS_URL:"redis://127.0.0.1:"+earlyRedisPort,E2E_DISPOSABLE_REDIS_CONTAINER:redis,
      });
    }
    else if(agentNativeV2UpgradeIntegration){
      earlyRedisPort=startDisposableRedis();
      await migrateAgentNativeV2LegacyDatabase(fixture,name,{
        ...process.env,DATABASE_URL:testUrl.toString(),S3_PRIVATE_BUCKET:bucket,E2E_ISOLATED_DAILY:"1",
        REDIS_URL:"redis://127.0.0.1:"+earlyRedisPort,E2E_DISPOSABLE_REDIS_URL:"redis://127.0.0.1:"+earlyRedisPort,E2E_DISPOSABLE_REDIS_CONTAINER:redis,
      });
    }
    else if(agentNativeUpgradeIntegration){
      earlyRedisPort=startDisposableRedis();
      await migrateAgentNativeLegacyDatabase(fixture,name,{
        ...process.env,DATABASE_URL:testUrl.toString(),S3_PRIVATE_BUCKET:bucket,E2E_ISOLATED_DAILY:"1",
        REDIS_URL:"redis://127.0.0.1:"+earlyRedisPort,E2E_DISPOSABLE_REDIS_URL:"redis://127.0.0.1:"+earlyRedisPort,E2E_DISPOSABLE_REDIS_CONTAINER:redis,
      });
    }
    else if(agentPlanUpgradeIntegration){
      earlyRedisPort=startDisposableRedis();
      await migrateAgentPlanLegacyDatabase(fixture,name,{
        ...process.env,DATABASE_URL:testUrl.toString(),S3_PRIVATE_BUCKET:bucket,E2E_ISOLATED_DAILY:"1",
        REDIS_URL:"redis://127.0.0.1:"+earlyRedisPort,E2E_DISPOSABLE_REDIS_URL:"redis://127.0.0.1:"+earlyRedisPort,E2E_DISPOSABLE_REDIS_CONTAINER:redis,
      });
    }
    else if (agentCommandUpgradeIntegration) {
      earlyRedisPort = startDisposableRedis();
      await migrateAgentCommandLegacyDatabase(fixture, name, {
        ...process.env, DATABASE_URL: testUrl.toString(), S3_PRIVATE_BUCKET: bucket, E2E_ISOLATED_DAILY: "1",
        REDIS_URL: `redis://127.0.0.1:${earlyRedisPort}`, E2E_DISPOSABLE_REDIS_URL: `redis://127.0.0.1:${earlyRedisPort}`,
        E2E_DISPOSABLE_REDIS_CONTAINER: redis,
      });
    }
    else if (agentLoopUpgradeIntegration) {
      earlyRedisPort = startDisposableRedis();
      await migrateAgentLoopLegacyDatabase(fixture, name, {
        ...process.env, DATABASE_URL: testUrl.toString(), S3_PRIVATE_BUCKET: bucket, E2E_ISOLATED_DAILY: "1",
        REDIS_URL: `redis://127.0.0.1:${earlyRedisPort}`, E2E_DISPOSABLE_REDIS_URL: `redis://127.0.0.1:${earlyRedisPort}`,
        E2E_DISPOSABLE_REDIS_CONTAINER: redis,
      });
    }
    else if (agentDelegationUpgradeIntegration) await migrateAgentDelegationLegacyDatabase(fixture, name, {
      ...process.env, DATABASE_URL: testUrl.toString(), S3_PRIVATE_BUCKET: bucket, E2E_ISOLATED_DAILY: "1",
    });
    else if (roleBenchmarkUpgradeIntegration) await migrateRoleBenchmarkLegacyDatabase(fixture, name, {
      ...process.env, DATABASE_URL: testUrl.toString(), S3_PRIVATE_BUCKET: bucket, E2E_ISOLATED_DAILY: "1",
    });
    else if (businessBenchmarkUpgradeIntegration) await migrateBusinessBenchmarkLegacyDatabase(fixture, name, {
      ...process.env, DATABASE_URL: testUrl.toString(), S3_PRIVATE_BUCKET: bucket, E2E_ISOLATED_DAILY: "1",
    });
    else if (knowledgeBenchmarkUpgradeIntegration) await migrateKnowledgeBenchmarkLegacyDatabase(fixture, name, {
      ...process.env, DATABASE_URL: testUrl.toString(), S3_PRIVATE_BUCKET: bucket, E2E_ISOLATED_DAILY: "1",
    });
    else if (knowledgeEvaluationUpgradeIntegration) await migrateKnowledgeEvaluationLegacyDatabase(fixture, name, {
      ...process.env, DATABASE_URL: testUrl.toString(), S3_PRIVATE_BUCKET: bucket, E2E_ISOLATED_DAILY: "1",
    });
    else if (factoryErpVoidReviewUpgradeIntegration) await migrateFactoryErpVoidReviewLegacyDatabase(fixture, name, {
      ...process.env, DATABASE_URL: testUrl.toString(), S3_PRIVATE_BUCKET: bucket, E2E_ISOLATED_DAILY: "1",
    });
    else if (factoryErpBindingUpgradeIntegration) await migrateFactoryErpBindingLegacyDatabase(fixture, name, {
      ...process.env, DATABASE_URL: testUrl.toString(), S3_PRIVATE_BUCKET: bucket, E2E_ISOLATED_DAILY: "1",
    });
    else if (factoryErpSourceRetentionUpgradeIntegration) await migrateFactoryErpSourceRetentionLegacyDatabase(fixture, name, {
      ...process.env, DATABASE_URL: testUrl.toString(), S3_PRIVATE_BUCKET: bucket, E2E_ISOLATED_DAILY: "1",
    });
    else if (factoryErpImportUpgradeIntegration) await migrateFactoryErpImportLegacyDatabase(fixture, name, {
      ...process.env, DATABASE_URL: testUrl.toString(), S3_PRIVATE_BUCKET: bucket, E2E_ISOLATED_DAILY: "1",
    });
    else if (qualityScrapUpgradeIntegration) await migrateQualityScrapLegacyDatabase(fixture, name);
    else if (productionQuantityUpgradeIntegration) await migrateProductionQuantityLegacyDatabase(fixture, name);
    else if (factoryCapacityUpgradeIntegration) await migrateFactoryCapacityLegacyDatabase(fixture, name);
    else if (financeCostAllocationUpgradeIntegration) await migrateFinanceCostAllocationLegacyDatabase(fixture, name);
    else if (financeCommandUpgradeIntegration) await migrateFinanceCommandLegacyDatabase(fixture, name);
    else if (financePayablesAdjustmentsUpgradeIntegration) await migrateFinancePayablesAdjustmentsLegacyDatabase(fixture, name);
    else if (financeAuthorityUpgradeIntegration) await migrateFinanceAuthorityLegacyDatabase(fixture, name);
    else if (financePayablesUpgradeIntegration) await migrateFinancePayablesLegacyDatabase(fixture, name);
    else if (financeMonetaryUpgradeIntegration) await migrateFinanceMonetaryLegacyDatabase(fixture, name);
    else if (invoiceReconciliationUpgradeIntegration) await migrateInvoiceReconciliationLegacyDatabase(fixture, name);
    else if (invoiceCommandUpgradeIntegration) await migrateInvoiceCommandLegacyDatabase(fixture, name);
    else if (procurementPrecisionUpgradeIntegration) await migrateProcurementPrecisionLegacyDatabase(fixture, name);
    else if (procurementUpgradeIntegration) await migrateProcurementLegacyDatabase(fixture, name);
    else if (incomingUpgradeIntegration) await migrateIncomingLegacyDatabase(fixture, name);
    else if (receiptRequestUpgradeIntegration) await migrateReceiptRequestLegacyDatabase(fixture, name);
    else if (inventoryUpgradeIntegration) await migrateInventoryLegacyDatabase(fixture, name);
    else if (shiposUpgradeIntegration) await migrateShiposLegacyDatabase(fixture, name);
    else if (manufacturingDeliveryUpgradeIntegration) await migrateManufacturingDeliveryLegacyDatabase(fixture, name);
    else if (manufacturingUpgradeIntegration) await migrateManufacturingLegacyDatabase(fixture, name);
    else if (qualityGroupsUpgradeIntegration) await migrateQualityGroupsLegacyDatabase(fixture, name);
    else if (shipmentUpgradeIntegration) await migrateShipmentLegacyDatabase(fixture, name);
    else if (qualityUpgradeIntegration) await migrateQualityLegacyDatabase(fixture, name);
    else await migrateDatabase(fixture);
    // Obtain an ordinary service token; no Keycloak configuration or real business data is changed.
    const response = await fetch(`${process.env.OIDC_ISSUER}/protocol/openid-connect/token`, {
      method: "POST",
      body: new URLSearchParams({
        client_id: process.env.LOCAL_OIDC_CLIENT_ID!,
        client_secret: process.env.LOCAL_OIDC_CLIENT_SECRET!,
        grant_type: "client_credentials",
      }),
    });
    if (!response.ok) throw new Error(`Fixture identity unavailable (${response.status})`);
    const auth = (await response.json()) as { access_token: string };
    const claims = JSON.parse(
      Buffer.from(auth.access_token.split(".")[1]!, "base64url").toString(),
    );
    if (typeof claims.tenant_id !== "string" || !/^[a-f0-9-]{36}$/.test(claims.tenant_id))
      throw new Error("Fixture token tenant missing");
    const tenant = claims.tenant_id,
      user = createEntityId(),
      member = createEntityId(),
      role = createEntityId();
    const otherErpTenant = createEntityId();
    if (factoryPortal || factoryCollaboration || erpPersonalBrowser) {
      factoryIdentity = await (agentMcpV2Browser ? startAgentMcpBrowserIdentityFixture : startFactoryIdentityFixture)(
        tenant,
        claims.sub,
        "http://localhost:3130",
        erpPersonalBrowser
          ? {
              application: "erp",
              clientId: "yummyai-web",
              accounts: {
                operator: { subject: claims.sub, name: "Synthetic ERP operator" },
                readonly: { subject: "synthetic-erp-reader", name: "Synthetic ERP reader" },
                outsider: {
                  subject: "synthetic-erp-outsider",
                  name: "Synthetic other tenant",
                  tenantId: otherErpTenant,
                },
              },
            }
          : {},
      );
      process.env.OIDC_ISSUER = factoryIdentity.baseUrl;
      process.env.OIDC_JWKS_URI = `${factoryIdentity.baseUrl}/protocol/openid-connect/certs`;
      process.env.API_ACCESS_TOKEN = await factoryIdentity.operatorToken();
      process.env.FACTORY_PORTAL_ONLY = factoryPortal ? "1" : "0";
      process.env.FACTORY_PORTAL_ORIGIN = "http://localhost:3130";
      process.env.FACTORY_OIDC_CLIENT_ID = "yummyai-factory";
      process.env.FACTORY_SESSION_ENCRYPTION_KEY = randomBytes(32).toString("base64url");
      process.env.FACTORY_IDENTITY_FIXTURE_URL = factoryIdentity.baseUrl;
      process.env.FACTORY_FIXTURE_CONTROL_TOKEN = factoryIdentity.controlKey;
      if (erpPersonalBrowser) {
        process.env.WEB_ORIGIN = "http://localhost:3130";
        process.env.OIDC_WEB_CLIENT_ID = "yummyai-web";
        process.env.ERP_SESSION_ENCRYPTION_KEY = randomBytes(32).toString("base64url");
        // Isolated API processes share a dedicated key for private originals.
        process.env.PROCUREMENT_COMMAND_ENCRYPTION_KEY = randomBytes(32).toString("base64url");
      }
    }
    await fixture.client.unsafe(
      "insert into organizations(id,name,slug) values ($1,'Synthetic daily acceptance',$2)",
      [tenant, `daily-${token}`],
    );
    await fixture.client.unsafe(
      "insert into app_users(id,oidc_subject,email,display_name) values ($1,$2,'synthetic@yummyai.invalid','Synthetic operator')",
      [user, claims.sub],
    );
    await fixture.client.unsafe(
      "insert into memberships(id,tenant_id,user_id,status) values ($1,$2,$3,'active')",
      [member, tenant, user],
    );
    await fixture.client.unsafe(
      "insert into roles(id,tenant_id,name,permissions,data_scope) values ($1,$2,'Fixture operator',$3::jsonb,'tenant')",
      [role, tenant, JSON.stringify(Object.values(Permission))],
    );
    await fixture.client.unsafe(
      "insert into membership_roles(tenant_id,membership_id,role_id) values ($1,$2,$3)",
      [tenant, member, role],
    );
    if (factoryPortal || factoryCollaboration || erpPersonalBrowser) {
      const accounts: Record<string, { membershipId: string; userId: string; name: string }> = {};
      for (const [key, account] of Object.entries(factoryFixtureAccounts)) {
        const userId = createEntityId(),
          membershipId = createEntityId();
        await fixture.client.unsafe(
          "insert into app_users(id,oidc_subject,email,display_name) values ($1,$2,$3,$4)",
          [userId, account.subject, `${key}@factory-fixture.invalid`, account.name],
        );
        await fixture.client.unsafe(
          "insert into memberships(id,tenant_id,user_id,status) values ($1,$2,$3,'active')",
          [membershipId, tenant, userId],
        );
        accounts[key] = { membershipId, userId, name: account.name };
      }
      process.env.FACTORY_FIXTURE_MEMBERS = JSON.stringify(accounts);
    }
    if (erpPersonalBrowser) {
      const actors: Record<
        string,
        { roleId: string; membershipId: string; userId: string; tenantId: string }
      > = { operator: { roleId: role, membershipId: member, userId: user, tenantId: tenant } };
      await fixture.client.unsafe(
        "insert into organizations(id,name,slug) values($1,'Synthetic other tenant',$2)",
        [otherErpTenant, `other-${token}`],
      );
      for (const [key, subject, name, target, rights] of [
        [
          "readonly",
          "synthetic-erp-reader",
          "Synthetic ERP reader",
          tenant,
          [
            Permission.ProductRead,
            Permission.DesignRead,
            Permission.ResearchRead,
            Permission.CaptureRead,
          ],
        ],
        [
          "outsider",
          "synthetic-erp-outsider",
          "Synthetic other tenant",
          otherErpTenant,
          [Permission.ProductRead, Permission.DesignRead, Permission.ProductWrite],
        ],
      ] as const) {
        const userId = createEntityId(),
          membershipId = createEntityId(),
          roleId = createEntityId();
        await fixture.client.unsafe(
          "insert into app_users(id,oidc_subject,email,display_name) values($1,$2,$3,$4)",
          [userId, subject, `${key}@erp-fixture.invalid`, name],
        );
        await fixture.client.unsafe(
          "insert into memberships(id,tenant_id,user_id,status) values($1,$2,$3,'active')",
          [membershipId, target, userId],
        );
        await fixture.client.unsafe(
          "insert into roles(id,tenant_id,name,permissions,data_scope) values($1,$2,$3,$4::jsonb,'tenant')",
          [roleId, target, `Synthetic ${key}`, JSON.stringify(rights)],
        );
        await fixture.client.unsafe(
          "insert into membership_roles(tenant_id,membership_id,role_id) values($1,$2,$3)",
          [target, membershipId, roleId],
        );
        actors[key] = { roleId, membershipId, userId, tenantId: target };
      }
      process.env.ERP_FIXTURE_ACTORS = JSON.stringify(actors);
    }
    // This family owns an exact empty initial catalogue and seeds every model
    // through the real configuration owner. Other suites retain the upscale seed.
    if (!studioModelSelectionSuiteRequested && !studioDraftRecoverySuiteRequested) {
      const provider = createEntityId(),
        model = createEntityId();
      const modelVault = createEnvironmentSecretVault(
        "MODEL_CREDENTIAL_ENCRYPTION_KEY",
        "yummyai:model-config",
      );
      await fixture.client.unsafe(
        "insert into model_provider_configs(id,tenant_id,provider,label,endpoint,encrypted_api_key,created_by) values($1,$2,'openai-compatible','Synthetic acceptance only','https://synthetic-daily.invalid/v1',$3,$4)",
        [provider, tenant, modelVault.encrypt("synthetic-daily-not-a-real-key"), user],
      );
      await fixture.client.unsafe(
        "insert into model_routes(id,tenant_id,model_key,task_type,targets) values($1,$2,'Synthetic upscale fixture','studio_image',$3::jsonb)",
        [
          model,
          tenant,
          JSON.stringify([
            {
              providerConfigId: provider,
              providerModel: "synthetic-upscale-fixture",
              timeoutMs: 60000,
            },
          ]),
        ],
      );
    }
  } finally {
    await fixture.client.end();
  }
  const port = earlyRedisPort ?? startDisposableRedis();
  const forwarded = acceptanceArgs;
  const knowledgeIntegration = forwarded.includes("--suite=knowledge-integration");
  const modelBillingIntegration = forwarded.includes("--suite=model-billing-integration");
  const podResponseIntegration = forwarded.includes("--suite=pod-response-integration");
  const methodIntegration = forwarded.includes("--suite=method-governance-integration");
  const executionMethodsIntegration = forwarded.includes("--suite=execution-methods-integration");
  const executionMethodsBrowser = forwarded.includes("--suite=execution-methods");
  const workerRuntime = forwarded.includes("--suite=worker-runtime");
  const backupRestore = forwarded.includes("--suite=backup-restore");
  const modelBilling = forwarded.includes("--suite=model-billing");
  const businessMethods = forwarded.includes("--suite=business-methods");
  const canvasSession = forwarded.includes("--suite=canvas-session");
  const methodWorkbench = forwarded.includes("--suite=methods");
  const knowledgeWorkspace = forwarded.includes("--suite=knowledge");
  const salesLaunch = forwarded.includes("--suite=sales-launch");
  const navigation = forwarded.includes("--suite=navigation");
  const creativeEditing = forwarded.includes("--suite=creative-editing"),
    creativeEditingIntegration = forwarded.includes("--suite=creative-editing-integration");
  const responsive = forwarded.includes("--suite=responsive");
  const canvasUpgrade = forwarded.includes("--suite=canvas-upgrade"),
    canvasIntegration = forwarded.includes("--suite=canvas-integration"),
    modelConfigurationIntegration = forwarded.includes("--suite=model-configuration-integration");
  const salesDelivery = forwarded.includes("--suite=sales-delivery");
  const salesDeliveryIntegration = forwarded.includes("--suite=sales-delivery-integration");
  const orderIntake = forwarded.includes("--suite=order-intake");
  const orderIntakeIntegration = forwarded.includes("--suite=order-intake-integration");
  const orderReview = forwarded.includes("--suite=order-review");
  const orderReviewIntegration = forwarded.includes("--suite=order-review-integration");
  const productVisuals = forwarded.includes("--suite=product-visuals");
  const productVisualsIntegration = forwarded.includes("--suite=product-visuals-integration");
  const aiTasks =
    forwarded.includes("--suite=ai-tasks") ||
    salesLaunch ||
    productVisuals ||
    salesDelivery ||
    orderIntake ||
    orderReview;
  const aiTasksIntegration = forwarded.includes("--suite=ai-tasks-integration");
  const mediaArchiveIntegration = forwarded.includes("--suite=media-archive-integration");
  const workflowIntegration = forwarded.includes("--suite=workflow-integration");
  const workflowExecutionIntegration = forwarded.includes("--suite=workflow-execution-integration");
  const orderExceptionOperations = forwarded.includes("--suite=order-exception-operations");
  const orderExceptionOperationsIntegration = forwarded.includes(
    "--suite=order-exception-operations-integration",
  );
  const businessFollowup = forwarded.includes("--suite=business-followup");
  const businessFollowupIntegration = forwarded.includes("--suite=business-followup-integration");
  const orderResponsibility =
    forwarded.includes("--suite=order-responsibility") ||
    businessFollowup ||
    orderExceptionOperations;
  const orderResponsibilityIntegration = forwarded.includes(
    "--suite=order-responsibility-integration",
  );
  const workflowTaskInboxIntegration = forwarded.includes(
    "--suite=workflow-task-inbox-integration",
  );
  const workflowResponsibilityIntegration =
    forwarded.includes("--suite=workflow-responsibility-integration") ||
    workflowTaskInboxIntegration;
  const workflowOperator = forwarded.includes("--suite=workflow-operator");
  const researchMedia = forwarded.includes("--suite=research-media");
  const advertisingIntegration = forwarded.includes("--suite=advertising-integration");
  const advertising = forwarded.includes("--suite=advertising");
  if (orderResponsibility) knowledgeSandbox = await createKnowledgeBrowserSandbox(token, 3128);
  if (methodWorkbench || businessMethods || canvasSession || executionMethodsBrowser)
    knowledgeSandbox = await createKnowledgeBrowserSandbox(token, 3130);
  if ((factoryPortal || factoryCollaboration || erpPersonalBrowser) && !compiledWeb && !productionCommandRestart)
    knowledgeSandbox = await createKnowledgeBrowserSandbox(token, 3130, "factory-portal");
  if (knowledgeWorkspace) knowledgeSandbox = await createKnowledgeBrowserSandbox(token);
  if (modelBilling) knowledgeSandbox = await createKnowledgeBrowserSandbox(token, 3129);
  if (workflowOperator)
    knowledgeSandbox = await createKnowledgeBrowserSandbox(token, 3124, "workflow-operator");
  if (navigation) knowledgeSandbox = await createKnowledgeBrowserSandbox(token, 3100);
  if (researchMedia)
    knowledgeSandbox = await createKnowledgeBrowserSandbox(token, 3126, "research-media");
  const designAgent = forwarded.includes("--suite=design-agent");
  const ruleCenter = forwarded.includes("--suite=rules");
  const ruleIntegration = forwarded.includes("--suite=rules-integration");
  const reportIntegration = forwarded.includes("--suite=report-integration");
  const artworkAuditIntegration = forwarded.includes("--suite=artwork-audit-integration");
  const productionHandoffIntegration = forwarded.includes("--suite=production-handoff-integration");
  const productionCommandIntegration = forwarded.includes("--suite=production-command-integration");
  const productionDeliveryIntegration = forwarded.includes(
    "--suite=production-delivery-integration",
  );
  const logisticsIntegration = forwarded.includes("--suite=logistics-integration");
  const logistics = forwarded.includes("--suite=logistics");
  if (logistics) knowledgeSandbox = await createKnowledgeBrowserSandbox(token, 3100);
  const publicationLeaseIntegration = forwarded.includes("--suite=publication-lease-integration");
  const allIntegration = forwarded.includes("--suite=all-integration") || publicationLeaseIntegration;
  const productAuthorityIntegration = forwarded.includes("--suite=product-authority-integration");
  const catalogScopeIntegration = forwarded.includes("--suite=catalog-scope-integration");
  const productionDelivery = forwarded.includes("--suite=production-delivery");
  const wholeOrder = forwarded.includes("--suite=whole-order");
  const factoryDirectoryIntegration = forwarded.includes("--suite=factory-directory-integration");
  const factoryDirectory = forwarded.includes("--suite=factory-directory");
  const databaseUpgrade = forwarded.includes("--suite=database-upgrade");
  const databaseIntegration = forwarded.includes("--suite=database-integration");
  const specificationProductionIntegration = specificationProductionIntegrationRequested;
  const integration =
    studioPersonalIntegration ||
    shipmentCreateIntegration ||
    agentNativeV4Integration || agentNativeV4LateIntegration || agentNativeV4UpgradeIntegration ||
    agentFulfillmentCommandIntegration || agentFulfillmentCommandUpgradeIntegration || orderSummaryIntegration || fulfillmentCommandIntegration || fulfillmentCommandUpgradeIntegration || agentDependencyPlanIntegration || agentDependencyPlanUpgradeIntegration || agentRuntimeReadinessIntegration || agentMcpReadinessIntegration || agentReadinessIntegration || publicationNodeSubmitIntegration || publicationNodeSubmitUpgradeIntegration || amazonPublicNodeIntegration || publicationAuthorityIntegration || publicationNodePreviewIntegration || publicationNodePreviewUpgradeIntegration || listingSyncIntentIntegration || listingSyncIntentUpgradeIntegration || storeNodeExecutionIntegration || storeNodeExecutionUpgradeIntegration || storeNodeIdentityIntegration || storeNodeIdentityUpgradeIntegration || marketplaceAuthorityIntegration || marketplaceAuthorityUpgradeIntegration || agentMcpV2Integration || agentNativeV3Integration || agentNativeV3UpgradeIntegration || agentFulfillmentIntegration || agentNativeV2Integration || agentNativeV2UpgradeIntegration || agentResourcesIntegration || agentMcpIntegration || agentNativeIntegration || agentNativeUpgradeIntegration || agentToolsIntegration || agentPlanIntegration || agentPlanUpgradeIntegration || agentCommandIntegration || agentCommandUpgradeIntegration || agentLoopIntegration || agentLoopUpgradeIntegration || agentEntryIntegration || agentReadIntegration || agentDelegationIntegration || agentDelegationUpgradeIntegration || roleBenchmarkIntegration || roleBenchmarkUpgradeIntegration || businessBenchmarkIntegration || businessBenchmarkUpgradeIntegration || knowledgeBenchmarkIntegration || knowledgeBenchmarkUpgradeIntegration ||
    knowledgeEvaluationIntegration || knowledgeEvaluationUpgradeIntegration ||
    factoryErpVoidReviewIntegration || factoryErpVoidReviewUpgradeIntegration ||
    factoryErpBindingIntegration || factoryErpBindingUpgradeIntegration ||
    factoryErpSourceRetentionIntegration ||
    factoryErpSourceRetentionUpgradeIntegration ||
    factoryErpImportUpgradeIntegration ||
    factoryErpImportIntegration ||
    productionCommandRestart ||
    productionCommandIntegration ||
    manufacturingDeliveryUpgradeIntegration ||
    manufacturingUpgradeIntegration ||
    shipmentUpgradeIntegration ||
    shipmentSourcesIntegration ||
    qualityGroupsIntegration ||
    qualityGroupsUpgradeIntegration ||
    qualityUpgradeIntegration ||
    databaseIntegration ||
    specificationProductionIntegration ||
    databaseUpgrade ||
    backupRestore ||
    catalogScopeIntegration ||
    productAuthorityIntegration ||
    executionMethodsIntegration ||
    methodIntegration ||
    workerRuntime ||
    podResponseIntegration ||
    modelBillingIntegration ||
    orderExceptionOperationsIntegration ||
    businessFollowupIntegration ||
    orderResponsibilityIntegration ||
    workflowResponsibilityIntegration ||
    workflowExecutionIntegration ||
    workflowIntegration ||
    mediaArchiveIntegration ||
    creativeEditingIntegration ||
    canvasIntegration ||
    modelConfigurationIntegration ||
    allIntegration ||
    logisticsIntegration ||
    qualityScrapIntegration || qualityScrapUpgradeIntegration || productionQuantityIntegration || productionQuantityUpgradeIntegration || factoryCapacityIntegration || factoryCapacityUpgradeIntegration || factoryAuthorityIntegration || advertisingIntegration || advertisingCommandIntegration || advertisingHistoryIntegration || advertisingMeasurementIntegration || advertisingAuthorityIntegration ||
    orderReviewIntegration ||
    orderIntakeIntegration ||
    salesDeliveryIntegration ||
    productVisualsIntegration ||
    aiTasksIntegration ||
    knowledgeIntegration ||
    forwarded.includes("--suite=design-agent-integration") ||
    ruleIntegration ||
    reportIntegration ||
    artworkAuditIntegration ||
    productionHandoffIntegration ||
    productionDeliveryIntegration ||
    factoryDirectoryIntegration ||
    shiposIntegration || inventoryIntegration || financeCommandIntegration || financeCommandProcessIntegration || financeCommandUpgradeIntegration || financeCostAllocationIntegration || financeCostAllocationUpgradeIntegration || financeLedgerIntegration || financeAuthorityIntegration || financeAuthorityUpgradeIntegration || financeMonetaryIntegration || financeMonetaryUpgradeIntegration || financeMonetaryRelatedIntegration || financePayablesIntegration || financePayablesUpgradeIntegration || financePayablesAdjustmentsIntegration || financePayablesAdjustmentsUpgradeIntegration;
  const extra: string[] = output.forwardedArgs.filter((arg: string) => !arg.startsWith("--suite=") && arg !== "--compiled-web");
  const browserExtra: string[] = output.forwardedArgs.filter((arg: string) => !arg.startsWith("--suite=") && arg !== "--compiled-web");
  const apiRequire = createRequire(new URL("../../apps/api/package.json", import.meta.url));
  if (studioPersonalIntegration || studioPersonalBrowser)
    await client.send(new CreateBucketCommand({ Bucket: bucket }));
  if (shipos || wholeOrder || qualityAssessmentBrowser || factoryCapacityBrowser || productionStopBrowser || qualityScrapBrowser) shiposFixture = await startShiposFixtureServer();
  if (logistics) logisticsFixture = await startLogisticsFixtureServer();
  const args = studioPersonalBrowser
    ? [require.resolve("@playwright/test/cli"), "test", "--config", studioDraftRecoveryBrowser ? "apps/web/playwright.studio-draft-recovery.config.ts" : studioModelSelectionBrowser ? "apps/web/playwright.studio-model-selection.config.ts" : studioVideoDirectoryBrowser ? "apps/web/playwright.studio-video-directory.config.ts" : studioDocumentTransferBrowser ? "apps/web/playwright.studio-document-transfer.config.ts" : studioOriginalBrowser ? "apps/web/playwright.studio-original.config.ts" : "apps/web/playwright.creative-studio-personal.config.ts", ...browserExtra, "--output", output.browserOutputDirectory]
    : studioPersonalIntegration
    ? [apiRequire.resolve("vitest/vitest.mjs"), "run", "--config", creativeRecoveryIntegration ? "vitest.creative-recovery.config.ts" : studioModelSelectionIntegration ? "vitest.studio-model-selection.config.ts" : studioVideoDirectoryIntegration ? "vitest.studio-video-directory.config.ts" : studioDocumentTransferIntegration ? "vitest.studio-document-transfer.config.ts" : studioOriginalIntegration ? "vitest.studio-original.config.ts" : "vitest.creative-studio-personal.config.ts", "--maxWorkers=1", "--cache=false", ...extra.filter(arg => arg !== "--cache=false")]
    : shipmentCreateBrowser
    ? [require.resolve("@playwright/test/cli"), "test", "--config", "apps/web/playwright.agent-native-v4-shipment-create.config.ts", ...browserExtra, "--output", output.browserOutputDirectory]
    : shipmentCreateIntegration
    ? [apiRequire.resolve("vitest/vitest.mjs"), "run", "--config", "vitest.shipment-create.config.ts", "--maxWorkers=1", "--cache=false", ...extra.filter(arg => arg !== "--cache=false")]
    : agentNativeV4Browser
    ? [require.resolve("@playwright/test/cli"), "test", "--config", "apps/web/playwright.agent-native-v4.config.ts", ...browserExtra, "--output", output.browserOutputDirectory]
    : agentNativeV4LateIntegration
    ? [apiRequire.resolve("vitest/vitest.mjs"), "run", "--config", "vitest.agent-native-v4-late.config.ts", "--maxWorkers=1", "--cache=false", ...extra.filter(arg => arg !== "--cache=false")]
    : agentNativeV4UpgradeIntegration
    ? [apiRequire.resolve("vitest/vitest.mjs"), "run", "--config", "vitest.agent-native-v4-upgrade.config.ts", "--maxWorkers=1", "--cache=false", ...extra.filter(arg => arg !== "--cache=false")]
    : agentNativeV4Integration
    ? [apiRequire.resolve("vitest/vitest.mjs"), "run", "--config", "vitest.agent-native-v4.config.ts", "--maxWorkers=1", "--cache=false", ...extra.filter(arg => arg !== "--cache=false")]
    : agentFulfillmentCommandUpgradeIntegration
    ? [apiRequire.resolve("vitest/vitest.mjs"), "run", "--config", "vitest.agent-fulfillment-command-upgrade.config.ts", "--maxWorkers=1", "--cache=false", ...extra.filter(arg => arg !== "--cache=false")]
    : agentFulfillmentCommandIntegration
    ? [apiRequire.resolve("vitest/vitest.mjs"), "run", "--config", "vitest.agent-fulfillment-command.config.ts", "--maxWorkers=1", "--cache=false", ...extra.filter(arg => arg !== "--cache=false")]
    : agentFulfillmentCommandBrowser
    ? [require.resolve("@playwright/test/cli"), "test", "--config", "apps/web/playwright.agent-fulfillment-command.config.ts", ...browserExtra, "--output", output.browserOutputDirectory]
    : orderSummaryIntegration
    ? [apiRequire.resolve("vitest/vitest.mjs"), "run", "--config", "vitest.order-summary-availability.config.ts", "--maxWorkers=1", "--cache=false", ...extra.filter(arg => arg !== "--cache=false")]
    : orderSummaryBrowser
    ? [require.resolve("@playwright/test/cli"), "test", "--config", "apps/web/playwright.order-summary-availability.config.ts", ...browserExtra, "--output", output.browserOutputDirectory]
    : fulfillmentCommandIntegration || fulfillmentCommandUpgradeIntegration
    ? [apiRequire.resolve("vitest/vitest.mjs"), "run", "--config", "vitest.fulfillment-command.config.ts", "--maxWorkers=1", "--cache=false", ...extra.filter(arg => arg !== "--cache=false")]
    : fulfillmentCommandBrowser
    ? [require.resolve("@playwright/test/cli"), "test", "--config", "apps/web/playwright.fulfillment-command.config.ts", ...browserExtra, "--output", output.browserOutputDirectory]
    : agentDependencyPlanIntegration || agentDependencyPlanUpgradeIntegration
    ? [apiRequire.resolve("vitest/vitest.mjs"), "run", "--config", "vitest.agent-dependency-plan.config.ts", "--maxWorkers=1", "--cache=false", ...extra.filter(arg => arg !== "--cache=false")]
    : agentDependencyPlanBrowser
    ? [require.resolve("@playwright/test/cli"), "test", "--config", "apps/web/playwright.agent-dependency-plan.config.ts", ...browserExtra, "--output", output.browserOutputDirectory]
    : agentRuntimeReadinessIntegration
    ? [apiRequire.resolve("vitest/vitest.mjs"), "run", "--config", "vitest.agent-runtime-readiness.config.ts", "--maxWorkers=1", "--cache=false", ...extra.filter(arg => arg !== "--cache=false")]
    : agentRuntimeReadinessBrowser
    ? [require.resolve("@playwright/test/cli"), "test", "--config", "apps/web/playwright.agent-runtime-readiness.config.ts", ...browserExtra, "--output", output.browserOutputDirectory]
    : agentMcpReadinessIntegration
    ? [apiRequire.resolve("vitest/vitest.mjs"), "run", "--config", "vitest.agent-mcp-readiness.config.ts", "--maxWorkers=1", "--cache=false", ...extra.filter(arg => arg !== "--cache=false")]
    : agentMcpReadinessBrowser
    ? [require.resolve("@playwright/test/cli"), "test", "--config", "apps/web/playwright.agent-mcp-readiness.config.ts", ...browserExtra, "--output", output.browserOutputDirectory]
    : agentReadinessIntegration
    ? [apiRequire.resolve("vitest/vitest.mjs"), "run", "--config", "vitest.agent-readiness.config.ts", "--maxWorkers=1", "--cache=false", ...extra.filter(arg => arg !== "--cache=false")]
    : agentReadinessBrowser
    ? [require.resolve("@playwright/test/cli"), "test", "--config", "apps/web/playwright.agent-readiness.config.ts", ...browserExtra, "--output", output.browserOutputDirectory]
    : publicationNodeSubmitIntegration||publicationNodeSubmitUpgradeIntegration
    ? [apiRequire.resolve("vitest/vitest.mjs"),"run","--config","vitest.publication-node-submit.config.ts","--maxWorkers=1","--cache=false",...extra.filter(arg=>arg!=="--cache=false")]
    : publicationNodeSubmitBrowser
    ? [require.resolve("@playwright/test/cli"),"test","--config","apps/web/playwright.publication-node-submit.config.ts",...browserExtra,"--output",output.browserOutputDirectory]
    : amazonPublicNodeIntegration || publicationAuthorityIntegration || publicationNodePreviewIntegration || publicationNodePreviewUpgradeIntegration
    ? [apiRequire.resolve("vitest/vitest.mjs"),"run","--config",amazonPublicNodeIntegration?"vitest.amazon-public-node.config.ts":publicationAuthorityIntegration?"vitest.publication-authority.config.ts":publicationNodePreviewUpgradeIntegration?"vitest.publication-node-preview-upgrade.config.ts":"vitest.publication-node-preview.config.ts","--maxWorkers=1","--cache=false",...extra.filter(arg=>arg!=="--cache=false")]
    : amazonPublicNodeBrowser
    ? [require.resolve("@playwright/test/cli"),"test","--config","apps/web/playwright.amazon-public-node.config.ts",...browserExtra,"--output",output.browserOutputDirectory]
    : publicationAuthorityBrowser
    ? [require.resolve("@playwright/test/cli"),"test","--config","apps/web/playwright.publication-authority.config.ts",...browserExtra,"--output",output.browserOutputDirectory]
    : publicationNodePreviewBrowser
    ? [require.resolve("@playwright/test/cli"),"test","--config","apps/web/playwright.publication-node-preview.config.ts",...browserExtra,"--output",output.browserOutputDirectory]
    : listingSyncIntentIntegration || listingSyncIntentUpgradeIntegration
    ? [apiRequire.resolve("vitest/vitest.mjs"), "run", "--config", listingSyncIntentUpgradeIntegration ? "vitest.listing-sync-intent-upgrade.config.ts" : "vitest.listing-sync-intent.config.ts", "--maxWorkers=1", "--cache=false", ...extra.filter(arg => arg !== "--cache=false")]
    : listingSyncIntentBrowser
    ? [require.resolve("@playwright/test/cli"), "test", "--config", "apps/web/playwright.listing-sync-intent.config.ts", ...browserExtra, "--output", output.browserOutputDirectory]
    : storeNodeExecutionIntegration || storeNodeExecutionUpgradeIntegration
    ? [apiRequire.resolve("vitest/vitest.mjs"), "run", "--config", storeNodeExecutionUpgradeIntegration ? "vitest.store-node-execution-upgrade.config.ts" : "vitest.store-node-execution.config.ts", "--maxWorkers=1", "--cache=false", ...extra.filter(arg => arg !== "--cache=false")]
    : storeNodeExecutionBrowser
    ? [require.resolve("@playwright/test/cli"), "test", "--config", "apps/web/playwright.store-node-execution.config.ts", ...browserExtra, "--output", output.browserOutputDirectory]
    : storeNodeIdentityIntegration || storeNodeIdentityUpgradeIntegration
    ? [apiRequire.resolve("vitest/vitest.mjs"), "run", "--config", storeNodeIdentityUpgradeIntegration ? "vitest.store-node-identity-upgrade.config.ts" : "vitest.store-node-identity.config.ts", "--maxWorkers=1", "--cache=false", ...extra.filter(arg => arg !== "--cache=false")]
    : storeNodeIdentityBrowser
    ? [require.resolve("@playwright/test/cli"), "test", "--config", "apps/web/playwright.store-node-identity.config.ts", ...browserExtra, "--output", output.browserOutputDirectory]
    : marketplaceAuthorityIntegration || marketplaceAuthorityUpgradeIntegration
    ? [apiRequire.resolve("vitest/vitest.mjs"), "run", "--config", marketplaceAuthorityUpgradeIntegration ? "vitest.marketplace-authority-upgrade.config.ts" : "vitest.marketplace-authority.config.ts", "--maxWorkers=1", "--cache=false", ...extra.filter(arg => arg !== "--cache=false")]
    : marketplaceAuthorityBrowser
    ? [require.resolve("@playwright/test/cli"), "test", "--config", "apps/web/playwright.marketplace-authority.config.ts", ...browserExtra, "--output", output.browserOutputDirectory]
    : agentMcpV2Integration
    ? [apiRequire.resolve("vitest/vitest.mjs"), "run", "--config", "vitest.agent-mcp-v2.config.ts", "--maxWorkers=1", "--cache=false", ...extra.filter(arg => arg !== "--cache=false")]
    : agentMcpV2Browser
    ? [require.resolve("@playwright/test/cli"), "test", "--config", "apps/web/playwright.agent-mcp-v2.config.ts", ...browserExtra, "--output", output.browserOutputDirectory]
    : agentNativeV3Integration
    ? [apiRequire.resolve("vitest/vitest.mjs"), "run", "--config", "vitest.agent-native-v3.config.ts", "--maxWorkers=1", "--cache=false", ...extra.filter(arg => arg !== "--cache=false")]
    : agentNativeV3UpgradeIntegration
    ? [apiRequire.resolve("vitest/vitest.mjs"), "run", "--config", "vitest.agent-native-v3-upgrade.config.ts", "--maxWorkers=1", "--cache=false", ...extra.filter(arg => arg !== "--cache=false")]
    : agentNativeV3Browser
    ? [require.resolve("@playwright/test/cli"), "test", "--config", "apps/web/playwright.agent-native-v3.config.ts", ...browserExtra, "--output", output.browserOutputDirectory]
    : agentFulfillmentIntegration
    ? [apiRequire.resolve("vitest/vitest.mjs"), "run", "--config", "vitest.agent-fulfillment.config.ts", "--maxWorkers=1", "--cache=false", ...extra.filter(arg => arg !== "--cache=false")]
    : agentFulfillmentBrowser
    ? [require.resolve("@playwright/test/cli"), "test", "--config", "apps/web/playwright.agent-fulfillment.config.ts", ...browserExtra, "--output", output.browserOutputDirectory]
    : agentNativeV2Integration
    ? [apiRequire.resolve("vitest/vitest.mjs"), "run", "--config", "vitest.agent-native-v2.config.ts", "--maxWorkers=1", "--cache=false", ...extra.filter(arg => arg !== "--cache=false")]
    : agentNativeV2UpgradeIntegration
    ? [apiRequire.resolve("vitest/vitest.mjs"), "run", "--config", "vitest.agent-native-v2-upgrade.config.ts", "--maxWorkers=1", "--cache=false", ...extra.filter(arg => arg !== "--cache=false")]
    : agentNativeV2Browser
    ? [require.resolve("@playwright/test/cli"), "test", "--config", "apps/web/playwright.agent-native-v2.config.ts", ...browserExtra, "--output", output.browserOutputDirectory]
    : agentResourcesIntegration
    ? [apiRequire.resolve("vitest/vitest.mjs"), "run", "--config", "vitest.agent-resources.config.ts", "--maxWorkers=1", "--cache=false", ...extra.filter(arg => arg !== "--cache=false")]
    : agentResourcesBrowser
    ? [require.resolve("@playwright/test/cli"), "test", "--config", "apps/web/playwright.agent-resources.config.ts", ...browserExtra, "--output", output.browserOutputDirectory]
    : agentMcpIntegration
    ? [apiRequire.resolve("vitest/vitest.mjs"), "run", "--config", "vitest.agent-mcp.config.ts", "--maxWorkers=1", "--cache=false", ...extra.filter(arg => arg !== "--cache=false")]
    : agentMcpBrowser
    ? [require.resolve("@playwright/test/cli"), "test", "--config", "apps/web/playwright.agent-mcp.config.ts", ...browserExtra, "--output", output.browserOutputDirectory]
    : agentNativeIntegration
    ? [apiRequire.resolve("vitest/vitest.mjs"), "run", "--config", "vitest.agent-native.config.ts", "--maxWorkers=1", "--cache=false", ...extra.filter(arg => arg !== "--cache=false")]
    : agentNativeUpgradeIntegration
    ? [apiRequire.resolve("vitest/vitest.mjs"), "run", "--config", "vitest.agent-native-upgrade.config.ts", "--maxWorkers=1", "--cache=false", ...extra.filter(arg => arg !== "--cache=false")]
    : agentNativeBrowser
    ? [require.resolve("@playwright/test/cli"), "test", "--config", "apps/web/playwright.agent-native.config.ts", ...browserExtra, "--output", output.browserOutputDirectory]
    : agentToolsIntegration
    ? [apiRequire.resolve("vitest/vitest.mjs"), "run", "--config", "vitest.agent-tools.config.ts", "--maxWorkers=1", "--cache=false", ...extra.filter(arg => arg !== "--cache=false")]
    : agentToolsBrowser
    ? [require.resolve("@playwright/test/cli"), "test", "--config", "apps/web/playwright.agent-tools.config.ts", ...browserExtra, "--output", output.browserOutputDirectory]
    : agentPlanIntegration
    ? [apiRequire.resolve("vitest/vitest.mjs"), "run", "--config", "vitest.agent-plan.config.ts", "--maxWorkers=1", "--cache=false", ...extra.filter(arg => arg !== "--cache=false")]
    : agentPlanUpgradeIntegration
    ? [apiRequire.resolve("vitest/vitest.mjs"), "run", "--config", "vitest.agent-plan-upgrade.config.ts", "--maxWorkers=1", "--cache=false", ...extra.filter(arg => arg !== "--cache=false")]
    : agentPlanBrowser
    ? [require.resolve("@playwright/test/cli"), "test", "--config", "apps/web/playwright.agent-plan.config.ts", ...browserExtra, "--output", output.browserOutputDirectory]
    : agentCommandIntegration
    ? [apiRequire.resolve("vitest/vitest.mjs"), "run", "--config", "vitest.agent-command.config.ts", "--maxWorkers=1", "--cache=false", ...extra.filter(arg => arg !== "--cache=false")]
    : agentCommandUpgradeIntegration
    ? [apiRequire.resolve("vitest/vitest.mjs"), "run", "--config", "vitest.agent-command-upgrade.config.ts", "--maxWorkers=1", "--cache=false", ...extra.filter(arg => arg !== "--cache=false")]
    : agentCommandBrowser
    ? [require.resolve("@playwright/test/cli"), "test", "--config", "apps/web/playwright.agent-command.config.ts", ...browserExtra, "--output", output.browserOutputDirectory]
    : agentLoopIntegration
    ? [apiRequire.resolve("vitest/vitest.mjs"), "run", "--config", "vitest.agent-loop.config.ts", "--maxWorkers=1", "--cache=false", ...extra.filter(arg => arg !== "--cache=false")]
    : agentLoopUpgradeIntegration
    ? [apiRequire.resolve("vitest/vitest.mjs"), "run", "--config", "vitest.agent-loop-upgrade.config.ts", "--maxWorkers=1", "--cache=false", ...extra.filter(arg => arg !== "--cache=false")]
    : agentLoopBrowser
    ? [require.resolve("@playwright/test/cli"), "test", "--config", "apps/web/playwright.agent-loop.config.ts", ...browserExtra, "--output", output.browserOutputDirectory]
    : agentEntryIntegration
    ? [apiRequire.resolve("vitest/vitest.mjs"), "run", "--config", "vitest.agent-entry.config.ts", "--maxWorkers=1", "--cache=false", ...extra.filter(arg => arg !== "--cache=false")]
    : agentEntryBrowser
    ? [require.resolve("@playwright/test/cli"), "test", "--config", "apps/web/playwright.agent-entry.config.ts", ...browserExtra, "--output", output.browserOutputDirectory]
    : agentReadIntegration
    ? [apiRequire.resolve("vitest/vitest.mjs"), "run", "--config", "vitest.agent-read.config.ts", "--maxWorkers=1", "--cache=false", ...extra.filter(arg => arg !== "--cache=false")]
    : agentReadBrowser
    ? [require.resolve("@playwright/test/cli"), "test", "--config", "apps/web/playwright.agent-read.config.ts", ...browserExtra, "--output", output.browserOutputDirectory]
    : agentDelegationUpgradeIntegration
    ? [apiRequire.resolve("vitest/vitest.mjs"), "run", "--config", "vitest.agent-delegation-upgrade.config.ts", "--maxWorkers=1", "--cache=false", ...extra.filter(arg => arg !== "--cache=false")]
    : agentDelegationIntegration
    ? [apiRequire.resolve("vitest/vitest.mjs"), "run", "--config", "vitest.agent-delegation.config.ts", "--maxWorkers=1", "--cache=false", ...extra.filter(arg => arg !== "--cache=false")]
    : agentDelegationBrowser
    ? [require.resolve("@playwright/test/cli"), "test", "--config", "apps/web/playwright.agent-delegation.config.ts", ...browserExtra, "--output", output.browserOutputDirectory]
    : roleBenchmarkUpgradeIntegration
    ? [apiRequire.resolve("vitest/vitest.mjs"), "run", "--config", "vitest.role-benchmark-upgrade.config.ts", "--maxWorkers=1", "--cache=false", ...extra.filter(arg => arg !== "--cache=false")]
    : roleBenchmarkIntegration
    ? [apiRequire.resolve("vitest/vitest.mjs"), "run", "--config", "vitest.role-benchmark.config.ts", "--maxWorkers=1", "--cache=false", ...extra.filter(arg => arg !== "--cache=false")]
    : roleBenchmarkBrowser
    ? [require.resolve("@playwright/test/cli"), "test", "--config", "apps/web/playwright.role-benchmark.config.ts", ...browserExtra, "--output", output.browserOutputDirectory]
    : businessBenchmarkUpgradeIntegration
    ? [apiRequire.resolve("vitest/vitest.mjs"), "run", "--config", "vitest.business-benchmark-upgrade.config.ts", "--maxWorkers=1", "--cache=false", ...extra.filter(arg => arg !== "--cache=false")]
    : businessBenchmarkIntegration
    ? [apiRequire.resolve("vitest/vitest.mjs"), "run", "--config", "vitest.business-benchmark.config.ts", "--maxWorkers=1", "--cache=false", ...extra.filter(arg => arg !== "--cache=false")]
    : businessBenchmarkBrowser
    ? [require.resolve("@playwright/test/cli"), "test", "--config", "apps/web/playwright.business-benchmark.config.ts", ...browserExtra, "--output", output.browserOutputDirectory]
    : knowledgeBenchmarkUpgradeIntegration
    ? [apiRequire.resolve("vitest/vitest.mjs"), "run", "--config", "vitest.knowledge-benchmark-upgrade.config.ts", "--maxWorkers=1", "--cache=false", ...extra.filter(arg => arg !== "--cache=false")]
    : knowledgeBenchmarkIntegration
    ? [apiRequire.resolve("vitest/vitest.mjs"), "run", "--config", "vitest.knowledge-benchmark.config.ts", "--maxWorkers=1", "--cache=false", ...extra.filter(arg => arg !== "--cache=false")]
    : knowledgeBenchmarkBrowser
    ? [require.resolve("@playwright/test/cli"), "test", "--config", "apps/web/playwright.knowledge-benchmark.config.ts", ...browserExtra, "--output", output.browserOutputDirectory]
    : knowledgeEvaluationUpgradeIntegration
    ? [apiRequire.resolve("vitest/vitest.mjs"), "run", "--config", "vitest.knowledge-evaluation-execution-upgrade.config.ts", "--maxWorkers=1", "--cache=false", ...extra.filter(arg => arg !== "--cache=false")]
    : knowledgeEvaluationIntegration
    ? [apiRequire.resolve("vitest/vitest.mjs"), "run", "--config", "vitest.knowledge-evaluation-execution.config.ts", "--maxWorkers=1", "--cache=false", ...extra.filter(arg => arg !== "--cache=false")]
    : knowledgeEvaluationBrowser
    ? [require.resolve("@playwright/test/cli"), "test", "--config", "apps/web/playwright.knowledge-evaluation-execution.config.ts", ...browserExtra, "--output", output.browserOutputDirectory]
    : factoryErpVoidReviewUpgradeIntegration
    ? [apiRequire.resolve("vitest/vitest.mjs"), "run", "--config", "vitest.factory-erp-void-reviews-upgrade.config.ts", "--maxWorkers=1", "--cache=false", ...extra.filter(arg => arg !== "--cache=false")]
    : factoryErpVoidReviewIntegration
    ? [apiRequire.resolve("vitest/vitest.mjs"), "run", "--config", "vitest.factory-erp-void-reviews.config.ts", "--maxWorkers=1", "--cache=false", ...extra.filter(arg => arg !== "--cache=false")]
    : factoryErpVoidReviewBrowser
    ? [require.resolve("@playwright/test/cli"), "test", "--config", "apps/web/playwright.factory-erp-void-reviews.config.ts", ...browserExtra, "--output", output.browserOutputDirectory]
    : factoryErpBindingUpgradeIntegration
    ? [apiRequire.resolve("vitest/vitest.mjs"), "run", "--config", "vitest.factory-erp-binding-corrections-upgrade.config.ts", "--maxWorkers=1", "--cache=false", ...extra]
    : factoryErpBindingIntegration
    ? [apiRequire.resolve("vitest/vitest.mjs"), "run", "--config", "vitest.factory-erp-binding-corrections.config.ts", "--maxWorkers=1", "--cache=false", ...extra]
    : factoryErpBindingBrowser
    ? [require.resolve("@playwright/test/cli"), "test", "--config", "apps/web/playwright.factory-erp-binding-corrections.config.ts", ...browserExtra, "--output", output.browserOutputDirectory]
    : factoryErpSourceRetentionUpgradeIntegration
    ? [apiRequire.resolve("vitest/vitest.mjs"), "run", "--config", "vitest.factory-erp-source-retention-upgrade.config.ts", "--maxWorkers=1", "--testTimeout=120000", ...extra]
    : factoryErpSourceRetentionIntegration
    ? [apiRequire.resolve("vitest/vitest.mjs"), "run", "--config", "vitest.factory-erp-source-retention.config.ts", "--maxWorkers=1", "--testTimeout=120000", ...extra]
    : factoryErpSourceRetentionBrowser
    ? [require.resolve("@playwright/test/cli"), "test", "--config", "apps/web/playwright.factory-erp-source-retention.config.ts", ...browserExtra, "--output", output.browserOutputDirectory]
    : factoryErpImportUpgradeIntegration
    ? [apiRequire.resolve("vitest/vitest.mjs"), "run", "--config", "vitest.factory-erp-import-upgrade.config.ts", "--maxWorkers=1", "--testTimeout=120000", ...extra]
    : factoryErpImportIntegration
    ? [apiRequire.resolve("vitest/vitest.mjs"), "run", "--config", "vitest.factory-erp-import.config.ts", "--maxWorkers=1", "--testTimeout=60000", ...extra]
    : factoryErpImportBrowser
    ? [require.resolve("@playwright/test/cli"), "test", "--config", "apps/web/playwright.factory-erp-import.config.ts", ...browserExtra, "--output", output.browserOutputDirectory]
    : qualityScrapUpgradeIntegration
    ? [apiRequire.resolve("vitest/vitest.mjs"), "run", "--config", "vitest.quality-scrap-upgrade.config.ts", "--maxWorkers=1", "--cache=false", ...extra.filter(arg => arg !== "--cache=false")]
    : qualityScrapIntegration
    ? [apiRequire.resolve("vitest/vitest.mjs"), "run", "--config", "vitest.quality-scrap.config.ts", "--maxWorkers=1", "--cache=false", ...extra.filter(arg => arg !== "--cache=false")]
    : productionQuantityUpgradeIntegration
    ? [apiRequire.resolve("vitest/vitest.mjs"), "run", "--config", "vitest.production-quantity-upgrade.config.ts", "--maxWorkers=1", "--cache=false", ...extra.filter(arg => arg !== "--cache=false")]
    : productionQuantityIntegration
    ? [apiRequire.resolve("vitest/vitest.mjs"), "run", "--config", "vitest.production-quantity.config.ts", "--maxWorkers=1", "--cache=false", ...extra.filter(arg => arg !== "--cache=false")]
    : factoryCapacityUpgradeIntegration
    ? [apiRequire.resolve("vitest/vitest.mjs"), "run", "--config", "vitest.factory-capacity-upgrade.config.ts", "--maxWorkers=1", "--cache=false", ...extra.filter(arg => arg !== "--cache=false")]
    : factoryCapacityIntegration
    ? [apiRequire.resolve("vitest/vitest.mjs"), "run", "--config", "vitest.factory-capacity.config.ts", "--maxWorkers=1", "--cache=false", ...extra.filter(arg => arg !== "--cache=false")]
    : factoryAuthorityIntegration
    ? [apiRequire.resolve("vitest/vitest.mjs"), "run", "--config", "vitest.factory-authority.config.ts", "--maxWorkers=1", "--cache=false", ...extra.filter(arg => arg !== "--cache=false")]
    : advertisingCommandIntegration
    ? [apiRequire.resolve("vitest/vitest.mjs"), "run", "--config", "vitest.advertising-command.config.ts", "--maxWorkers=1", "--cache=false", ...extra.filter(arg => arg !== "--cache=false")]
    : advertisingHistoryIntegration
    ? [apiRequire.resolve("vitest/vitest.mjs"), "run", "--config", "vitest.advertising-history.config.ts", "--maxWorkers=1", "--cache=false", ...extra.filter(arg => arg !== "--cache=false")]
    : advertisingMeasurementIntegration
    ? [apiRequire.resolve("vitest/vitest.mjs"), "run", "--config", "vitest.advertising-measurement.config.ts", "--maxWorkers=1", "--cache=false", ...extra.filter(arg => arg !== "--cache=false")]
    : advertisingAuthorityIntegration
    ? [apiRequire.resolve("vitest/vitest.mjs"), "run", "--config", "vitest.advertising-authority.config.ts", "--maxWorkers=1", "--cache=false", ...extra.filter(arg => arg !== "--cache=false")]
    : financeCommandIntegration || financeCommandProcessIntegration || financeCommandUpgradeIntegration
    ? [apiRequire.resolve("vitest/vitest.mjs"), "run", "--config", "vitest.integration.config.ts", "--maxWorkers=1", "--cache=false",
      ...(financeCommandResultIntegration ? ["src/finance/finance-command-result.integration.test.ts"] : financeCommandUpgradeIntegration ? ["src/finance/finance-command-upgrade.integration.test.ts"] : financeCommandProcessIntegration ? ["src/finance/finance-command-process.integration.test.ts"]
        : financeCommandReadLockIntegration ? ["src/finance/finance-command-read-lock.integration.test.ts"] : financeCommandBusinessIntegration ? ["src/finance/finance-command.integration.test.ts"] : financeCommandGuardIntegration ? ["src/finance/finance-command-guard.integration.test.ts"]
          : ["src/finance/finance-command.integration.test.ts", "src/finance/finance-command-guard.integration.test.ts"]), ...extra.filter(arg => arg !== "--cache=false")]
    : financeCostAllocationIntegration || financeCostAllocationUpgradeIntegration
    ? [apiRequire.resolve("vitest/vitest.mjs"), "run", "--config", "vitest.integration.config.ts", "--maxWorkers=1", "--cache=false",
       ...(financeCostAllocationUpgradeIntegration ? ["src/finance/finance-cost-allocation-upgrade.integration.test.ts"]
         : ["src/finance/finance-cost-allocation.integration.test.ts", "src/finance/finance-cost-allocation-guard.integration.test.ts", "src/orders/order-review-allocation.integration.test.ts", "src/finance/finance.integration.test.ts"]), ...extra.filter(arg => arg !== "--cache=false")]
    : financeLedgerIntegration
    ? [apiRequire.resolve("vitest/vitest.mjs"), "run", "--config", "vitest.integration.config.ts", "--maxWorkers=1", "--cache=false",
       "src/finance/finance-ledger.integration.test.ts", "src/finance/finance.integration.test.ts", "src/finance/finance-payables.integration.test.ts", "src/finance/finance-payables-adjustments.integration.test.ts", ...extra.filter(arg => arg !== "--cache=false")]
    : financePayablesAdjustmentsIntegration || financePayablesAdjustmentsUpgradeIntegration
    ? [apiRequire.resolve("vitest/vitest.mjs"), "run", "--config", "vitest.integration.config.ts", "--maxWorkers=1", "--cache=false",
       ...(financePayablesAdjustmentsUpgradeIntegration ? ["src/finance/finance-payables-adjustments-upgrade.integration.test.ts"]
         : ["src/finance/finance-payables-adjustments.integration.test.ts", "src/finance/finance-payables.integration.test.ts"]), ...extra.filter(arg => arg !== "--cache=false")]
    : financeAuthorityIntegration || financeAuthorityUpgradeIntegration
    ? [apiRequire.resolve("vitest/vitest.mjs"), "run", "--config", "vitest.integration.config.ts", "--maxWorkers=1", "--cache=false",
       ...(financeAuthorityUpgradeIntegration ? ["src/finance/finance-authority-upgrade.integration.test.ts"] : ["src/finance/finance-authority.integration.test.ts", "src/finance/finance-source-guard.integration.test.ts"]), ...extra.filter(arg => arg !== "--cache=false")]
    : financePayablesIntegration || financePayablesUpgradeIntegration
    ? [apiRequire.resolve("vitest/vitest.mjs"), "run", "--config", "vitest.integration.config.ts", "--maxWorkers=1", "--cache=false",
       financePayablesUpgradeIntegration ? "src/finance/finance-payables-upgrade.integration.test.ts" : "src/finance/finance-payables.integration.test.ts", ...extra.filter(arg => arg !== "--cache=false")]
    : financeMonetaryIntegration || financeMonetaryUpgradeIntegration || financeMonetaryRelatedIntegration
    ? [apiRequire.resolve("vitest/vitest.mjs"), "run", "--config", "vitest.integration.config.ts", "--maxWorkers=1", "--cache=false",
       ...(financeMonetaryUpgradeIntegration ? ["src/finance/finance-monetary-upgrade.integration.test.ts"] : financeMonetaryIntegration
         ? ["src/finance/finance-monetary.integration.test.ts"] : ["src/finance/finance.integration.test.ts"]), ...extra.filter(arg => arg !== "--cache=false")]
    : productionCommandRestart
    ? ["--import", "./node_modules/tsx/dist/loader.mjs", "../../tools/testing/production-command-restart.mts", ...extra]
    : databaseUpgrade
    ? ["--import", "./node_modules/tsx/dist/loader.mjs", "../../tools/testing/database-upgrade-acceptance.mts", ...extra]
    : productionCommandIntegration
    ? [apiRequire.resolve("vitest/vitest.mjs"), "run", "--config", "vitest.integration.config.ts", "--maxWorkers=1", "src/orders/production-manufacturing.integration.test.ts", "src/orders/order-workspace.integration.test.ts", "--cache=false", ...extra]
    : specificationProductionIntegration
    ? [apiRequire.resolve("vitest/vitest.mjs"), "run", "--config", "vitest.integration.config.ts", "--maxWorkers=1", "--cache=false", "src/catalog/specification-production-purpose.integration.test.ts"]
    : databaseIntegration
    ? [apiRequire.resolve("vitest/vitest.mjs"), "run", "--config", "vitest.integration.config.ts", "--maxWorkers=1", ...extra]
    : backupRestore
    ? ["--import", "./node_modules/tsx/dist/loader.mjs", "../../tools/testing/backup-restore-acceptance.mts", ...extra]
    : catalogScopeIntegration
    ? [
        apiRequire.resolve("vitest/vitest.mjs"),
        "run",
        "--config",
        "vitest.integration.config.ts",
        "--maxWorkers=1",
        "--testTimeout=60000",
        "src/auth/team-directory.integration.test.ts",
        "src/auth/membership-context.integration.test.ts",
        "src/auth/identity-session.integration.test.ts",
        "src/catalog/product-authority.integration.test.ts",
        "src/catalog/product-spu.integration.test.ts",
        "src/catalog/product-development.integration.test.ts",
        "src/catalog/sales-plan.integration.test.ts",
        "src/catalog/sales-plan-delivery.integration.test.ts",
        ...extra,
      ]
    : productAuthorityIntegration
      ? [
          apiRequire.resolve("vitest/vitest.mjs"),
          "run",
          "--config",
          "vitest.integration.config.ts",
          "--maxWorkers=1",
          "--testTimeout=60000",
          "src/catalog/product-authority.integration.test.ts",
          "src/catalog/catalog.integration.test.ts",
          "src/auth/membership-context.integration.test.ts",
          "src/auth/identity-session.integration.test.ts",
          ...extra,
        ]
      : executionMethodsIntegration
        ? [
            apiRequire.resolve("vitest/vitest.mjs"),
            "run",
            "--config",
            "vitest.integration.config.ts",
            "--maxWorkers=1",
            "--testTimeout=60000",
            "src/workflows/execution-methods.integration.test.ts",
            "src/workflows/workflow-execution.integration.test.ts",
            "src/design/pod-response-recovery.integration.test.ts",
            "src/design/pod-artwork-task.integration.test.ts",
            "src/design/pod-governance.integration.test.ts",
            "src/knowledge/method-governance.integration.test.ts",
            ...extra,
          ]
        : methodIntegration
          ? [
              apiRequire.resolve("vitest/vitest.mjs"),
              "run",
              "--config",
              "vitest.integration.config.ts",
              "--maxWorkers=1",
              "--testTimeout=60000",
              "src/knowledge/method-governance.integration.test.ts",
              "src/knowledge/knowledge-governance.integration.test.ts",
              "src/ai/assist.integration.test.ts",
              ...extra,
            ]
          : workerRuntime
            ? [
                "--import",
                "./node_modules/tsx/dist/loader.mjs",
                "../../tools/testing/worker-runtime-acceptance.mts",
                ...extra,
              ]
            : podResponseIntegration
              ? [
                  apiRequire.resolve("vitest/vitest.mjs"),
                  "run",
                  "--config",
                  "vitest.integration.config.ts",
                  "--maxWorkers=1",
                  "--testTimeout=60000",
                  "src/design/pod-response-recovery.integration.test.ts",
                  "src/design/pod-artwork-task.integration.test.ts",
                  "src/workflows/workflow-execution.integration.test.ts",
                  ...extra,
                ]
              : modelBillingIntegration
                ? [
                    apiRequire.resolve("vitest/vitest.mjs"),
                    "run",
                    "--config",
                    "vitest.integration.config.ts",
                    "--maxWorkers=1",
                    "--testTimeout=60000",
                    "src/ai/model-billing.integration.test.ts",
                    "src/ai/assist.integration.test.ts",
                    "src/design/pod-artwork-task.integration.test.ts",
                    ...extra,
                  ]
                : orderExceptionOperationsIntegration
                  ? [
                      apiRequire.resolve("vitest/vitest.mjs"),
                      "run",
                      "--config",
                      "vitest.integration.config.ts",
                      "--maxWorkers=1",
                      "--testTimeout=60000",
                      "src/orders/order-exception-operations.integration.test.ts",
                      "src/orders/order.integration.test.ts",
                      "src/business-followups/business-followup.integration.test.ts",
                      ...extra,
                    ]
                  : businessFollowupIntegration
                    ? [
                        apiRequire.resolve("vitest/vitest.mjs"),
                        "run",
                        "--config",
                        "vitest.integration.config.ts",
                        "--maxWorkers=1",
                        "--testTimeout=60000",
                        "src/business-followups/business-followup.integration.test.ts",
                        "src/procurement/procurement.integration.test.ts",
                        "src/orders/order-after-sales.integration.test.ts",
                        ...extra,
                      ]
                    : orderResponsibilityIntegration
                      ? [
                          apiRequire.resolve("vitest/vitest.mjs"),
                          "run",
                          "--config",
                          "vitest.integration.config.ts",
                          "--maxWorkers=1",
                          "--testTimeout=60000",
                          "src/orders/order-responsibility.integration.test.ts",
                          "src/orders/order-task-projection.test.ts",
                          ...extra,
                        ]
                      : workflowResponsibilityIntegration
                        ? [
                            apiRequire.resolve("vitest/vitest.mjs"),
                            "run",
                            "--config",
                            "vitest.integration.config.ts",
                            "--maxWorkers=1",
                            "--testTimeout=60000",
                            "src/workflows/workflow-responsibility.integration.test.ts",
                            "src/workflows/workflow-center.integration.test.ts",
                            ...(workflowTaskInboxIntegration
                              ? ["src/workflows/workflow-task-inbox.integration.test.ts"]
                              : []),
                            ...extra,
                          ]
                        : workflowExecutionIntegration
                          ? [
                              apiRequire.resolve("vitest/vitest.mjs"),
                              "run",
                              "--config",
                              "vitest.integration.config.ts",
                              "--maxWorkers=1",
                              "--testTimeout=60000",
                              "src/workflows/workflow-execution.integration.test.ts",
                              "src/workflows/workflow-center.integration.test.ts",
                              "src/catalog/catalog.integration.test.ts",
                              "src/design/pod-artwork-task.integration.test.ts",
                              "src/design/pod-governance.integration.test.ts",
                              ...extra,
                            ]
                          : workflowIntegration
                            ? [
                                apiRequire.resolve("vitest/vitest.mjs"),
                                "run",
                                "--config",
                                "vitest.integration.config.ts",
                                "--maxWorkers=1",
                                "--testTimeout=60000",
                                "src/workflows/workflow-center.integration.test.ts",
                                "src/workflows/workflow-graph.validator.test.ts",
                                ...extra,
                              ]
                            : mediaArchiveIntegration
                              ? [
                                  apiRequire.resolve("vitest/vitest.mjs"),
                                  "run",
                                  "--config",
                                  "vitest.integration.config.ts",
                                  "--maxWorkers=1",
                                  "--testTimeout=60000",
                                  "src/capture/capture-media.integration.test.ts",
                                  "src/capture/capture.integration.test.ts",
                                  "src/research/research-study.integration.test.ts",
                                  ...extra,
                                ]
                              : allIntegration
                                ? publicationLeaseIntegration
                                  ? [apiRequire.resolve("vitest/vitest.mjs"), "run",
                                      "--root", fileURLToPath(new URL("../../apps/worker/", import.meta.url)),
                                      "--config", fileURLToPath(new URL("../../apps/worker/vitest.integration.config.ts", import.meta.url)),
                                      "--maxWorkers=1", "--cache=false", "src/processors/marketplace-publication-lease.integration.test.ts", ...extra]
                                  : [process.env.npm_execpath!, ...workspaceIntegrationArgs(extra)]
                                : logisticsIntegration
                                  ? [
                                      apiRequire.resolve("vitest/vitest.mjs"),
                                      "run",
                                      "--config",
                                      "vitest.integration.config.ts",
                                      "--maxWorkers=1",
                                      "--testTimeout=60000",
                                      "src/logistics/logistics.integration.test.ts",
                                      "src/catalog/product-development.integration.test.ts",
                                      "src/orders/order-production-delivery.integration.test.ts",
                                      ...extra,
                                    ]
                                  : advertisingIntegration
                                    ? [
                                        apiRequire.resolve("vitest/vitest.mjs"),
                                        "run",
                                        "--config",
                                        "vitest.integration.config.ts",
                                        "--maxWorkers=1",
                                        "--testTimeout=60000",
                                        "src/customer-intelligence/advertising.integration.test.ts",
                                        "src/customer-intelligence/customer-intelligence.integration.test.ts",
                                        ...extra,
                                      ]
                                    : manufacturingDeliveryUpgradeIntegration
                                      ? [apiRequire.resolve("vitest/vitest.mjs"), "run", "--config", "vitest.integration.config.ts", "--maxWorkers=1", "--testTimeout=60000", "src/orders/manufacturing-delivery-upgrade.integration.test.ts", ...extra]
                                    : manufacturingUpgradeIntegration
                                      ? [apiRequire.resolve("vitest/vitest.mjs"), "run", "--config", "vitest.integration.config.ts", "--maxWorkers=1", "--testTimeout=60000", "src/orders/manufacturing-upgrade.integration.test.ts", ...extra]
                                    : shipmentUpgradeIntegration
                                      ? [apiRequire.resolve("vitest/vitest.mjs"), "run", "--config", "vitest.integration.config.ts", "--maxWorkers=1", "--testTimeout=60000", "src/orders/shipment-upgrade.integration.test.ts", ...extra]
                                    : qualityGroupsUpgradeIntegration
                                      ? [apiRequire.resolve("vitest/vitest.mjs"), "run", "--config", "vitest.integration.config.ts", "--maxWorkers=1", "--testTimeout=60000", "src/orders/quality-groups-upgrade.integration.test.ts", ...extra]
                                    : qualityGroupsIntegration
                                      ? [apiRequire.resolve("vitest/vitest.mjs"), "run", "--config", "vitest.integration.config.ts", "--maxWorkers=1", "--testTimeout=60000", "src/orders/quality-groups.integration.test.ts", ...extra]
                                    : shipmentSourcesIntegration
                                      ? [apiRequire.resolve("vitest/vitest.mjs"), "run", "--config", "vitest.integration.config.ts", "--maxWorkers=1", "--testTimeout=60000", "src/orders/order-shipment.integration.test.ts", "src/orders/order-shipment-physical-evidence.integration.test.ts", "src/orders/shipment-production-sources.integration.test.ts", "src/orders/order-workspace.integration.test.ts", ...extra]
                                    : qualityUpgradeIntegration
                                      ? [apiRequire.resolve("vitest/vitest.mjs"), "run", "--config", "vitest.integration.config.ts", "--maxWorkers=1", "--testTimeout=60000", "src/orders/quality-upgrade.integration.test.ts", ...extra]
                                    : orderReviewIntegration
                                      ? [
                                          apiRequire.resolve("vitest/vitest.mjs"),
                                          "run",
                                          "--config",
                                          "vitest.integration.config.ts",
                                          "--maxWorkers=1",
                                          "--testTimeout=60000",
                                          "src/orders/order-workspace.integration.test.ts",
                                          "src/finance/finance.integration.test.ts",
                                          "src/orders/order-production-delivery.integration.test.ts",
                                          ...extra,
                                        ]
                                      : orderIntakeIntegration
                                        ? [
                                            apiRequire.resolve("vitest/vitest.mjs"),
                                            "run",
                                            "--config",
                                            "vitest.integration.config.ts",
                                            "--maxWorkers=1",
                                            "--testTimeout=60000",
                                            "src/orders/order-workspace.integration.test.ts",
                                            "src/orders/order.integration.test.ts",
                                            ...extra,
                                          ]
                                        : productVisualsIntegration || salesDeliveryIntegration
                                          ? [
                                              apiRequire.resolve("vitest/vitest.mjs"),
                                              "run",
                                              "--config",
                                              "vitest.integration.config.ts",
                                              "--maxWorkers=1",
                                              "--testTimeout=60000",
                                              ...(salesDeliveryIntegration
                                                ? [
                                                    "src/catalog/sales-plan-delivery.integration.test.ts",
                                                    "src/catalog/product-development.integration.test.ts",
                                                  ]
                                                : []),
                                              "src/catalog/product-visuals.integration.test.ts",
                                              "src/design/creative-studio.integration.test.ts",
                                              "src/design/canvas-bridge.integration.test.ts",
                                              "src/catalog/sales-plan.integration.test.ts",
                                              ...extra,
                                            ]
                                          : integration
                                            ? [
                                                apiRequire.resolve("vitest/vitest.mjs"),
                                                "run",
                                                "--config",
                                                "vitest.integration.config.ts",
                                                "--maxWorkers=1",
                                                "--testTimeout=60000",
                                                ...(creativeEditingIntegration
                                                  ? [
                                                      "src/design/canvas-bridge.integration.test.ts",
                                                      "src/design/creative-studio.integration.test.ts",
                                                      "src/content-projects/content-project.integration.test.ts",
                                                    ]
                                                  : modelConfigurationIntegration
                                                    ? ["src/ai/model-configuration.integration.test.ts"]
                                                  : canvasIntegration
                                                    ? [
                                                        "src/ai/model-configuration.integration.test.ts",
                                                        "src/design/creative-studio.integration.test.ts",
                                                      ]
                                                    : aiTasksIntegration
                                                      ? [
                                                          "src/ai/assist.integration.test.ts",
                                                          "src/design/pod-governance.integration.test.ts",
                                                        ]
                                                      : knowledgeIntegration
                                                        ? [
                                                            "src/knowledge/knowledge-governance.integration.test.ts",
                                                            "src/knowledge/knowledge.integration.test.ts",
                                                            "src/ai/assist.integration.test.ts",
                                                            "src/catalog/product-development.integration.test.ts",
                                                          ]
                                                        : inventoryIntegration
                                                          ? invoiceReconciliationUpgradeIntegration ? ["src/procurement/invoice-reconciliation-upgrade.integration.test.ts"] : invoiceReconciliationIntegration ? ["src/procurement/invoice-reconciliation.integration.test.ts"] : invoiceCommandUpgradeIntegration ? ["src/procurement/invoice-command-upgrade.integration.test.ts"] : invoiceCommandIntegration ? ["src/procurement/invoice-command.integration.test.ts"] : procurementPrecisionUpgradeIntegration ? ["src/procurement/procurement-precision-upgrade.integration.test.ts"] : procurementPrecisionIntegration ? ["src/procurement/procurement-precision.integration.test.ts"] : procurementUpgradeIntegration ? ["src/procurement/procurement-upgrade.integration.test.ts"] : procurementProcessIntegration ? ["src/procurement/procurement-command-process.integration.test.ts"] : incomingUpgradeIntegration ? ["src/procurement/incoming-upgrade.integration.test.ts"] : incomingProcessIntegration ? ["src/procurement/incoming-command-process.integration.test.ts"] : incomingInspectionIntegration ? ["src/procurement/incoming-inspection.integration.test.ts"] : receiptRequestUpgradeIntegration ? ["src/procurement/receipt-request-upgrade.integration.test.ts"] : inventoryUpgradeIntegration ? ["src/inventory/inventory-upgrade.integration.test.ts"] : ["src/inventory/inventory.integration.test.ts", "src/procurement/procurement.integration.test.ts"]
                                                        : shiposIntegration
                                                          ? [
                                                              shiposUpgradeIntegration ? "src/suppliers/shipos-upgrade.integration.test.ts" : "src/suppliers/shipos.integration.test.ts",
                                                            ]
                                                          : factoryDirectoryIntegration
                                                            ? [
                                                                "src/suppliers/factory-directory.integration.test.ts",
                                                                "src/orders/order-production-delivery.integration.test.ts",
                                                                "src/orders/order-production.integration.test.ts",
                                                                "src/orders/order-workspace.integration.test.ts",
                                                                "src/orders/order-routing.integration.test.ts",
                                                                "src/supplier-performance/supplier-performance.integration.test.ts",
                                                              ]
                                                            : productionDeliveryIntegration
                                                              ? [
                                                                  "src/orders/order-production-delivery.integration.test.ts",
                                                                  "src/orders/order-production.integration.test.ts",
                                                                ]
                                                              : productionHandoffIntegration
                                                                ? [
                                                                    "src/orders/order-workspace.integration.test.ts",
                                                                    "src/design/production-editor.integration.test.ts",
                                                                  ]
                                                                : artworkAuditIntegration
                                                                  ? [
                                                                      "src/ai/assist.integration.test.ts",
                                                                    ]
                                                                  : reportIntegration
                                                                    ? [
                                                                        "src/orders/amazon-order-report.integration.test.ts",
                                                                        "src/orders/order.integration.test.ts",
                                                                        "src/orders/order-money.integration.test.ts",
                                                                        "src/orders/order-after-sales.integration.test.ts",
                                                                        "src/orders/order-routing.integration.test.ts",
                                                                      ]
                                                                    : ruleIntegration
                                                                      ? [
                                                                          "src/rules/rule-center.integration.test.ts",
                                                                          "src/orders/order-design-agent.integration.test.ts",
                                                                        ]
                                                                      : [
                                                                          "src/design/production-editor.integration.test.ts",
                                                                          "src/design/creative-studio.integration.test.ts",
                                                                          "src/orders/order-workspace.integration.test.ts",
                                                                          "src/orders/order-design-agent.integration.test.ts",
                                                                        ]),
                                                ...extra,
                                              ]
                                            : [
                                                require.resolve("@playwright/test/cli"),
                                                "test",
                                                "--config",
                                                erpPersonalBrowser
                                                  ? ordinaryDailyBrowser ? "apps/web/playwright.order-daily-personal.config.ts" : qualityScrapBrowser ? "apps/web/playwright.quality-scrap.config.ts" : productionStopBrowser ? "apps/web/playwright.production-stop.config.ts" : factoryCapacityBrowser ? "apps/web/playwright.factory-capacity.config.ts" : factoryAuthorityBrowser ? "apps/web/playwright.factory-authority.config.ts" : advertisingCommandBrowser ? "apps/web/playwright.advertising-command.config.ts" : advertisingHistoryBrowser ? "apps/web/playwright.advertising-history.config.ts" : advertisingMeasurementBrowser ? "apps/web/playwright.advertising-measurement.config.ts" : advertisingAuthorityBrowser ? "apps/web/playwright.advertising-authority.config.ts" : financeCommandResultBrowser ? "apps/web/playwright.finance-command-result.config.ts" : financeCommandBrowser ? "apps/web/playwright.finance-command.config.ts" : orderProfitReviewBrowser ? "apps/web/playwright.order-profit-review.config.ts" : financeCostAllocationBrowser ? "apps/web/playwright.finance-cost-allocation.config.ts" : financeLedgerBrowser ? "apps/web/playwright.finance-ledger.config.ts" : financePayablesAdjustmentsBrowser ? "apps/web/playwright.finance-payables-adjustments.config.ts" : financeAuthorityBrowser ? "apps/web/playwright.finance-authority.config.ts" : financePayablesBrowser ? "apps/web/playwright.finance-payables.config.ts" : financeMonetaryBrowser ? "apps/web/playwright.finance-monetary.config.ts" : invoiceReconciliationBrowser ? "apps/web/playwright.procurement-invoice-reconciliation.config.ts" : invoiceCommandBrowser ? "apps/web/playwright.procurement-invoice-command.config.ts" : procurementPrecisionBrowser ? "apps/web/playwright.procurement-precision.config.ts" : procurementCycleBrowser ? "apps/web/playwright.procurement-cycle.config.ts" : shipos
                                                    ? "apps/web/playwright.shipos.config.ts"
                                                    : incomingBrowser ? "apps/web/playwright.incoming.config.ts"
                                                    : salesCompositionBrowser
                                                    ? salesEditorLifecycleBrowser ? "apps/web/playwright.sales-editor-lifecycle.config.ts" : "apps/web/playwright.sales-composition.config.ts"
                                                    : channelMappingBrowser
                                                      ? "apps/web/playwright.channel-mapping.config.ts"
                                                      : salesPackageHistoryBrowser
                                                        ? "apps/web/playwright.sales-package-history.config.ts"
                                                        : catalogEditorBrowser
                                                          ? "apps/web/playwright.catalog-editor.config.ts"
                                                          : productionDeliveryBrowser
                                                            ? "apps/web/playwright.production-delivery.config.ts"
                                                          : productionHandoffBrowser
                                                            ? "apps/web/playwright.production-handoff.config.ts"
                                                          : manufacturingBrowser
                                                            ? "apps/web/playwright.manufacturing.config.ts"
                                                          : qualityAssessmentBrowser
                                                            ? "apps/web/playwright.quality-assessment.config.ts"
                                                          : specificationFactsBrowser
                                                            ? "apps/web/playwright.specification-facts.config.ts"
                                                          : salesPlanReferencesBrowser
                                                            ? "apps/web/playwright.sales-plan-references.config.ts"
                                                            : salesPlanSessionBrowser
                                                              ? "apps/web/playwright.sales-plan-session.config.ts"
                                                              : listingAuthorityBrowser
                                                                ? "apps/web/playwright.listing-authority.config.ts"
                                                                : productAccessBrowser
                                                                  ? "apps/web/playwright.product-access.config.ts"
                                                                  : factoryDirectory
                                                                    ? "apps/web/playwright.factory-directory.config.ts"
                                                                    : teamBrowser
                                                                    ? "apps/web/playwright.teams.config.ts"
                                                                    : "apps/web/playwright.erp-identity.config.ts"
                                                  : factoryPortal
                                                    ? "apps/web/playwright.factory-portal.config.ts"
                                                    : factoryCollaboration
                                                      ? "apps/web/playwright.factory-collaboration.config.ts"
                                                      : executionMethodsBrowser
                                                        ? "apps/web/playwright.execution-methods.config.ts"
                                                        : canvasSession
                                                          ? "apps/web/playwright.canvas-session.config.ts"
                                                          : businessMethods
                                                            ? "apps/web/playwright.business-methods.config.ts"
                                                            : methodWorkbench
                                                              ? "apps/web/playwright.methods.config.ts"
                                                              : modelBilling
                                                                ? "apps/web/playwright.model-billing.config.ts"
                                                                : orderExceptionOperations
                                                                  ? "apps/web/playwright.order-exception-operations.config.ts"
                                                                  : businessFollowup
                                                                    ? "apps/web/playwright.business-followup.config.ts"
                                                                    : orderResponsibility
                                                                      ? "apps/web/playwright.order-responsibility.config.ts"
                                                                      : researchMedia
                                                                        ? "apps/web/playwright.research-media.config.ts"
                                                                        : workflowOperator
                                                                          ? "apps/web/playwright.workflow-operator.config.ts"
                                                                          : creativeEditing
                                                                            ? "apps/web/playwright.creative-editing.config.ts"
                                                                            : canvasUpgrade
                                                                              ? "apps/web/playwright.canvas-upgrade.config.ts"
                                                                              : responsive
                                                                                ? "apps/web/playwright.responsive.config.ts"
                                                                                : navigation
                                                                                  ? "apps/web/playwright.navigation.config.ts"
                                                                                  : logistics
                                                                                    ? "apps/web/playwright.logistics.config.ts"
                                                                                    : advertising
                                                                                      ? "apps/web/playwright.advertising.config.ts"
                                                                                      : orderReview
                                                                                        ? "apps/web/playwright.order-review.config.ts"
                                                                                        : orderIntake
                                                                                          ? "apps/web/playwright.order-intake.config.ts"
                                                                                          : salesDelivery
                                                                                            ? "apps/web/playwright.sales-delivery.config.ts"
                                                                                            : salesLaunch ||
                                                                                                productVisuals
                                                                                              ? "apps/web/playwright.sales-launch.config.ts"
                                                                                              : aiTasks
                                                                                                ? "apps/web/playwright.ai-tasks.config.ts"
                                                                                                : knowledgeWorkspace
                                                                                                  ? "apps/web/playwright.knowledge.config.ts"
                                                                                                  : shipos
                                                                                                    ? "apps/web/playwright.shipos.config.ts"
                                                                                                    : wholeOrder
                                                                                                      ? "apps/web/playwright.whole-order.config.ts"
                                                                                                      : factoryDirectory
                                                                                                        ? "apps/web/playwright.factory-directory.config.ts"
                                                                                                        : productionDelivery
                                                                                                          ? "apps/web/playwright.production-delivery.config.ts"
                                                                                                          : ruleCenter
                                                                                                            ? "apps/web/playwright.rules.config.ts"
                                                                                                            : designAgent
                                                                                                              ? "apps/web/playwright.design-agent.config.ts"
                                                                                                              : "apps/web/playwright.order-daily.config.ts",
                                                ...browserExtra,
                                                "--output", output.browserOutputDirectory,
                                              ];
  exitCode = await new Promise<number>((resolve, reject) => {
    if (knowledgeSandbox) {
      process.env.KNOWLEDGE_BROWSER_CWD = knowledgeSandbox.cwd;
      process.env.KNOWLEDGE_BROWSER_COMMAND = knowledgeSandbox.command;
    } else if (compiledWeb) {
      process.env.KNOWLEDGE_BROWSER_CWD = webCandidate?.web ?? fileURLToPath(new URL("../../apps/web/", import.meta.url));
      process.env.KNOWLEDGE_BROWSER_COMMAND =
        '"' +
        process.execPath +
        '" "' +
        fileURLToPath(new URL(webCandidate
          ? "./start-web.mjs"
          : "../../apps/web/node_modules/next/dist/bin/next", import.meta.url)) +
        '" start ' + (webCandidateId ? '--candidate ' + webCandidateId + ' ' : '') +
        '--hostname 127.0.0.1 --port 3130';
    }
    const child = spawn(process.execPath, args, {
      cwd: new URL(databaseIntegration ? "../../packages/database/" : integration && !allIntegration ? "../../apps/api/" : "../../", import.meta.url),
      windowsHide: true,
      stdio: "inherit",
      env: {
        ...process.env,
        ...output.environment,
        ...(orderProfitReviewBrowser ? {
          NODE_OPTIONS: `--import "${new URL("../../apps/api/node_modules/tsx/dist/loader.mjs", import.meta.url).href}"`,
          TSX_TSCONFIG_PATH: fileURLToPath(new URL("../../apps/api/tsconfig.json", import.meta.url)),
          TSX_DISABLE_CACHE: "1",
        } : {}),
        DATABASE_URL: testUrl.toString(),
        YUMMYAI_TEST_CACHE_DIR: artifactDirectory,
        S3_PRIVATE_BUCKET: bucket,
        REDIS_URL: `redis://127.0.0.1:${port}`,
        E2E_DISPOSABLE_REDIS_CONTAINER: redis,
        E2E_DISPOSABLE_REDIS_URL: `redis://127.0.0.1:${port}`,
        API_BASE_URL: qualityScrapBrowser ? `http://127.0.0.1:${qualityScrapApiPort}` : productionStopBrowser ? `http://127.0.0.1:${productionStopApiPort}` : factoryCapacityBrowser ? `http://127.0.0.1:${factoryCapacityApiPort}` : factoryAuthorityBrowser ? `http://127.0.0.1:${factoryAuthorityApiPort}` : advertisingCommandBrowser ? `http://127.0.0.1:${advertisingCommandApiPort}` :
          factoryPortal || factoryCollaboration || erpPersonalBrowser
            ? "http://127.0.0.1:8130"
            : methodWorkbench || businessMethods || canvasSession || executionMethodsBrowser
              ? "http://127.0.0.1:8128"
              : modelBilling
                ? "http://127.0.0.1:8126"
                : orderResponsibility
                  ? "http://127.0.0.1:8124"
                  : researchMedia
                    ? "http://127.0.0.1:8122"
                    : workflowOperator
                      ? "http://127.0.0.1:8120"
                      : advertising
                        ? "http://127.0.0.1:8118"
                        : aiTasks
                          ? "http://127.0.0.1:8116"
                          : knowledgeWorkspace
                            ? "http://127.0.0.1:8112"
                            : shipos
                              ? "http://127.0.0.1:8110"
                              : wholeOrder
                                ? "http://127.0.0.1:8114"
                                : "http://127.0.0.1:8000",
        E2E_ISOLATED_DAILY: "1",
        ...(orderResponsibility ? { ORDER_RESPONSIBILITY_TENANT_IDS: "*" } : {}),
        ...(businessFollowup || orderExceptionOperations
          ? { BUSINESS_FOLLOWUP_TENANT_IDS: "*" }
          : {}),
        ...(workflowOperator || executionMethodsBrowser
          ? {
              WORKFLOW_CENTER_TENANT_IDS: "*",
              POD_ENABLED_TOOLS: "pattern_crop",
              POD_PROCESSOR_DEPLOYMENT_ID: "synthetic-workflow-operator",
              POD_PROCESSOR_URL: "https://workflow-fixture.invalid",
              POD_PROCESSOR_API_KEY: "synthetic-fixture-only",
            }
          : {}),
        ...(shiposFixture ? { SHIPOS_TEST_BASE_URL: shiposFixture.baseUrl } : {}),
        ...(logisticsFixture ? { LOGISTICS_TEST_BASE_URL: logisticsFixture.baseUrl } : {}),
      },
    });
    child.once("error", reject);
    child.once("close", (code) => resolve(code ?? 1));
  });
} finally {
  if (logisticsFixture) {
    const counts = logisticsFixture.counts();
    await writeFile(
      new URL(`../../tmp/logistics-transport-proof-${token}.json`, import.meta.url),
      JSON.stringify(counts, null, 2),
    );
    await logisticsFixture.close();
    if (counts.duplicateCreates || counts.forbiddenRequests) exitCode = 1;
  }
  if (shiposFixture) {
    const counts = shiposFixture.counts();
    await writeFile(
      new URL(`../../tmp/shipos-query-proof-${token}.json`, import.meta.url),
      JSON.stringify(counts, null, 2),
    );
    await shiposFixture.close();
    if (counts.forbiddenRequests !== 0) exitCode = 1;
  }
  const errors: string[] = [];
  if (studioRuntime) {
    try {
      await new Promise<void>((resolve, reject) => {
        studioRuntime!.close(error => error ? reject(error) : resolve());
        studioRuntime!.closeAllConnections();
      });
      manifest.studioRuntime!.closed = true;
    } catch { errors.push("Studio runtime fixture cleanup failed"); }
  }
  if (factoryIdentity) {
    try {
      await writeFile(
        new URL(`../../tmp/factory-identity-proof-${token}.json`, import.meta.url),
        JSON.stringify(factoryIdentity.proof(), null, 2),
      );
      await factoryIdentity.close();
      manifest.identityServiceClosed = true;
    } catch {
      manifest.identityServiceClosed = false;
      errors.push("Factory identity fixture cleanup failed");
    }
  }
  if (knowledgeSandbox) {
    try {
      await knowledgeSandbox.cleanup();
      manifest.browserSandboxDeleted = true;
    } catch {
      manifest.browserSandboxDeleted = false;
      errors.push("Knowledge browser sandbox cleanup failed");
    }
  }
  try {
    execFileSync("docker", ["rm", "--force", redis], { stdio: "pipe", windowsHide: true });
  } catch {
    /* May not have been created. Verify below. */
  }
  try {
    manifest.redisDeleted =
      execFileSync(
        "docker",
        ["ps", "--all", "--filter", `name=^${redis}$`, "--format", "{{.Names}}"],
        { encoding: "utf8", windowsHide: true },
      ).trim() === "";
    if (!manifest.redisDeleted) errors.push("Redis fixture retained");
  } catch {
    errors.push("Redis cleanup verification failed");
  }
  try {
    await cleanupBucket();
  } catch (error) {
    if (errorInfo(error).name !== "NoSuchBucket") errors.push("Bucket cleanup failed");
  }
  try {
    await client.send(new HeadBucketCommand({ Bucket: bucket }));
    errors.push("Bucket fixture retained");
  } catch (error) {
    manifest.bucketDeleted = errorInfo(error).$metadata?.httpStatusCode === 404;
    if (!manifest.bucketDeleted) errors.push("Bucket cleanup verification failed");
  }
  try {
    await admin.client.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    manifest.databaseDeleted =
      (await admin.client.unsafe("select datname from pg_database where datname=$1", [name]))
        .length === 0;
  } catch {
    errors.push("Database cleanup failed");
  }
  manifest.testExitCode = exitCode;
  manifest.cleanupErrors = errors;
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
  await admin.client.end();
  client.destroy();
  console.log(JSON.stringify(manifest));
  if (errors.length) exitCode = 1;
}
process.exitCode = exitCode;

async function cleanupBucket() {
  // This bucket is the exact nonce fixture owned by this runner. Deleting current
  // keys alone leaves retained versions and delete markers in versioned suites.
  for (let page = 0; ; page++) {
    if (page >= 10000) throw new Error("Fixture version cleanup did not converge");
    const versions = await client.send(new ListObjectVersionsCommand({ Bucket: bucket, MaxKeys: 1000 }));
    const keys = [...(versions.Versions ?? []), ...(versions.DeleteMarkers ?? [])]
      .map((object: { Key?: string; VersionId?: string }) => {
        if (!object.Key || !object.VersionId) throw new Error("Fixture version identity missing");
        return { Key: object.Key, VersionId: object.VersionId };
      });
    if (!keys.length) {
      if (versions.IsTruncated) throw new Error("Fixture version cleanup returned an empty truncated page");
      break;
    }
    const deleted = await client.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: keys, Quiet: true } }));
    if (deleted.Errors?.length) throw new Error("Fixture version cleanup failed");
  }
  for (;;) {
    const objects = await client.send(new ListObjectsV2Command({ Bucket: bucket }));
    const keys = objects.Contents?.map((object: { Key: string }) => ({ Key: object.Key })) ?? [];
    if (!keys.length) break;
    const deleted = await client.send(
      new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: keys, Quiet: true } }),
    );
    if (deleted.Errors?.length) throw new Error("Fixture object cleanup failed");
  }
  await client.send(new DeleteBucketCommand({ Bucket: bucket }));
}
function errorInfo(error: unknown) {
  return (typeof error === "object" && error !== null ? error : {}) as {
    name?: string;
    $metadata?: { httpStatusCode?: number };
  };
}


