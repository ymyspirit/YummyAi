import { createHash, randomBytes, randomUUID } from "node:crypto";
import { SecretVault } from "@yummyai/ai-core";
import { Permission } from "@yummyai/authz";
import { createEntityId, TenantContextSchema, type TenantContext } from "@yummyai/contracts";
import { AGENT_COMMAND_VERSION, PrepareAgentCommandSchema, AdoptAgentCommandSchema, ConfirmAgentCommandSchema,
  canonicalAgentCommandRequest, type AgentCommandOriginal, type AgentCommandView } from "@yummyai/contracts/ai/agent-command";
import { AdGoalFieldsSchema } from "@yummyai/contracts/advertising";
import { withTenant, roles, loadCurrentMembershipContext, type DatabaseConnection } from "@yummyai/database";
import { ClamAvScanner, createStorageFromEnvironment } from "@yummyai/storage";
import { eq, sql } from "drizzle-orm";
import { requireDisposableIntegrationEnvironment } from "../../../../tools/testing/require-disposable-integration.mjs";
import { procurementCommandFixture } from "../procurement/procurement-command.fixtures.js";
import { ProcurementCommandService } from "../procurement/procurement-command.service.js";
import { createProcurementCommandVault } from "../procurement/procurement-command-vault.js";
import { IncomingInspectionService } from "../procurement/incoming-inspection.service.js";
import { IncomingCommandService } from "../procurement/incoming-command.service.js";
import { createIncomingCommandVault } from "../procurement/incoming-command-vault.js";
import { FinanceCommandService } from "../finance/finance-command.service.js";
import { FinanceCommandOwnerAdapter } from "../finance/finance-command-owner.js";
import { FinanceCommandResultReader } from "../finance/finance-command-result.reader.js";
import { createFinanceCommandVault } from "../finance/finance-command-vault.js";
import { FinanceService } from "../finance/finance.service.js";
import { FinancePayablesService } from "../finance/finance-payables.service.js";
import { FinancePayablesAdjustmentsService } from "../finance/finance-payables-adjustments.service.js";
import { FinanceCostAllocationService } from "../finance/finance-cost-allocation.service.js";
import { AdvertisingService } from "../customer-intelligence/advertising.service.js";
import { AdvertisingCommandService } from "../customer-intelligence/advertising-command.service.js";
import { AdvertisingCommandOwnerAdapter } from "../customer-intelligence/advertising-command-owner.js";
import { createAdvertisingCommandVault } from "../customer-intelligence/advertising-command-vault.js";
import { AdSourceGateway } from "../customer-intelligence/ad-source.gateway.js";
import { OrderService } from "../orders/order.service.js";
import { createOrderPiiVault } from "../orders/order-pii-vault.js";
import { OrderProductionService } from "../orders/order-production.service.js";
import { ProductionCommandService } from "../orders/production-command.service.js";
import { AuditService } from "../audit/audit.service.js";
import { InventoryService } from "../inventory/inventory.service.js";
import { ProcurementService } from "../procurement/procurement.service.js";
import { AgentCommandOwnerAdapter } from "./agent-command-owner.js";
import { AgentCommandService } from "./agent-command.service.js";

export function requireAgentCommandEnvironment(environment: NodeJS.ProcessEnv = process.env, target = "current") {
  const url = new URL(requireDisposableIntegrationEnvironment(environment));
  const nonce = /^\/order_daily_e2e_([a-f0-9]{32})$/.exec(url.pathname)?.[1];
  if (!nonce || environment.E2E_AGENT_COMMAND_ISOLATED !== "1" || environment.E2E_ISOLATED_DAILY !== "1" ||
    environment.E2E_LEGACY_SCHEMA_TARGET !== target || environment.S3_PRIVATE_BUCKET !== `order-daily-e2e-${nonce}` ||
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
    throw new Error("Agent commands require their exact isolated nonce database and bucket before construction or connection");
  return { url: url.href, nonce };
}
export const agentCommandSha = (text: string) => createHash("sha256").update(text).digest("hex");
export const commandPermissions = [Permission.WorkflowRead, Permission.WorkflowRun, Permission.ProcurementRead, Permission.ProcurementWrite,
  Permission.ProcurementApprove, Permission.InventoryRead, Permission.InventoryWrite, Permission.ProductRead, Permission.ProductWrite,
  Permission.FinanceRead, Permission.FinanceWrite, Permission.FinanceReview, Permission.CustomerIntelligenceRead,
  Permission.CustomerIntelligenceWrite, Permission.CustomerIntelligenceReview, Permission.OrderRead, Permission.OrderWrite, Permission.OrderPiiRead];

/** Only identity/source admission is synthetic. Every command, financial fact,
 * inventory effect and audit is produced by its actual owner. The production
 * branch proves a missing-source refusal and never manufactures artwork approval. */
export function agentCommandOwners(database: DatabaseConnection, options: { contentVault?: SecretVault } = {}) {
  requireAgentCommandEnvironment();
  const audit = new AuditService(database), inventory = new InventoryService(database, audit);
  const procurementOwner = new ProcurementService(database, inventory, audit), incomingOwner = new IncomingInspectionService(database, procurementOwner, audit);
  const procurement = new ProcurementCommandService(database, createProcurementCommandVault(), procurementOwner, audit);
  const incoming = new IncomingCommandService(database, createIncomingCommandVault(), incomingOwner, audit);
  const financeOwner = new FinanceService(database, audit), payables = new FinancePayablesService(database, audit);
  const adjustments = new FinancePayablesAdjustmentsService(database, audit), costs = new FinanceCostAllocationService(database, audit);
  const finance = new FinanceCommandService(database, createFinanceCommandVault(), new FinanceCommandOwnerAdapter(financeOwner, payables, adjustments, costs), audit, new FinanceCommandResultReader());
  const storage = createStorageFromEnvironment(), advertisingOwner = new AdvertisingService(database, audit, new AdSourceGateway(storage, new ClamAvScanner()));
  const advertising = new AdvertisingCommandService(database, createAdvertisingCommandVault(), new AdvertisingCommandOwnerAdapter(advertisingOwner), audit);
  const orderVault = createOrderPiiVault(), orders = new OrderService(database, orderVault, audit);
  const production = new ProductionCommandService(database, orderVault, new OrderProductionService(database, orderVault, orders, audit));
  const adapter = new AgentCommandOwnerAdapter(procurement, incoming, production, finance, advertising);
  const contentVault = options.contentVault ?? new SecretVault(randomBytes(32));
  const service = (ttl?: number) => new AgentCommandService(database, contentVault, adapter, audit, ttl);
  return { audit, inventory, procurementOwner, incomingOwner, financeOwner, payables, adjustments, costs,
    procurement, incoming, production, finance, advertising, advertisingOwner, orders, adapter, contentVault, service };
}

export function agentCommandFixture(database: DatabaseConnection) {
  requireAgentCommandEnvironment();
  const source = procurementCommandFixture(database), owners = agentCommandOwners(database);
  const current = async (ceiling: TenantContext = context) => {
    const fresh = await withTenant(database.db, ceiling, tx => loadCurrentMembershipContext(tx, ceiling));
    return TenantContextSchema.parse({ ...ceiling, ...fresh });
  };
  const context = TenantContextSchema.parse({ ...source.context, permissions: commandPermissions });
  const coworker = TenantContextSchema.parse({ ...source.coworker, permissions: commandPermissions });
  const outsider = TenantContextSchema.parse({ ...source.outsider, permissions: commandPermissions });
  async function initialize() {
    await source.initialize();
    for (const actor of [context, coworker, outsider]) await source.setPermissions(actor, commandPermissions);
  }
  async function grant(actor: TenantContext, permissions: Permission[], dataScope: TenantContext["dataScope"] = "tenant") {
    await withTenant(database.db, actor, tx => tx.update(roles).set({ permissions, dataScope }).where(eq(roles.id, source.roleIds.get(actor.userId)!)));
  }
  async function procurementOriginal(kind: "requisition_create" | "purchase_create" = "requisition_create"): Promise<AgentCommandOriginal> {
    const basis = await source.basis(context);
    return kind === "requisition_create" ? { domain: "procurement", command: { kind, targetId: null, input: basis.requisitionInput } }
      : { domain: "procurement", command: { kind, targetId: null, input: basis.purchaseInput } };
  }
  function billOriginal(): AgentCommandOriginal {
    return { domain: "finance", command: { kind: "bill_record", targetId: null, input: { supplierId: source.supplierId,
      kind: "factory_invoice", externalBillId: "SYNTHETIC-AGENT-" + createEntityId(), currency: "USD", amountMinor: 12345,
      issuedAt: "2026-07-01T00:00:00.000Z", dueAt: null, procurementInvoiceId: null, idempotencyKey: randomUUID() } } };
  }
  async function incomingOriginal(): Promise<AgentCommandOriginal> {
    const basis = await source.basis(context);
    return { domain: "incoming", command: { kind: "publish_standard", targetId: basis.stock.id, input: { code: "AGENT-" + createEntityId().slice(-8).toUpperCase(),
      stockItemId: basis.stock.id, expectedVersion: 0, title: "Synthetic measured material", sourceReference: "Synthetic supplier specification; no supplier contact",
      criteria: [{ code: "WIDTH", label: "Width", kind: "numeric_range", unit: "mm", minimum: "9", maximum: "11" }], idempotencyKey: randomUUID() } } };
  }
  async function advertisingOriginal(): Promise<AgentCommandOriginal> {
    const accountId = createEntityId();
    await database.client.unsafe("insert into marketplace_accounts(id,tenant_id,platform,display_name,region,authorization_mode,created_by) values($1,$2,'amazon','Synthetic Agent advertising','NA','amazon_private',$3)", [accountId, context.tenantId, context.userId]);
    return { domain: "advertising", command: { kind: "goal_save", accountId, targetId: null, input: {
      scope: { accountId, marketplace: "US", currency: "USD", asin: "B012345678" }, expectedRevision: 0,
      fields: AdGoalFieldsSchema.parse({ mode: "profit_defense", effectiveFrom: "2026-09-01", targetAcosBps: 2100, unitPriceMinor: 10000,
        unitCostMinor: 7000, coreKeywords: [], protectedTerms: [], trialEndDate: null, trialSpendLimitMinor: null, cooldownDays: 30 }), idempotencyKey: randomUUID() } } };
  }
  const prepare = (original: AgentCommandOriginal, requestId = randomUUID()) => PrepareAgentCommandSchema.parse({ version: AGENT_COMMAND_VERSION, requestId, original });
  const adopt = (view: AgentCommandView) => AdoptAgentCommandSchema.parse({ version: AGENT_COMMAND_VERSION, requestId: randomUUID(),
    reference: { domain: view.domain, commandId: view.ownerCommandId, accountId: view.snapshot?.reference.accountId ?? null } });
  const confirmation = (view: AgentCommandView) => ConfirmAgentCommandSchema.parse({ version: AGENT_COMMAND_VERSION, requestId: view.requestId,
    ownerCommandId: view.ownerCommandId, originalChecksum: view.originalChecksum, confirmationToken: view.confirmationToken, decision: "execute_original" });
  const receipt = (operation: "prepare" | "adopt", input: unknown) => {
    const parsed = operation === "prepare" ? PrepareAgentCommandSchema.parse(input) : AdoptAgentCommandSchema.parse(input);
    return { requestId: parsed.requestId, requestChecksum: agentCommandSha(canonicalAgentCommandRequest(operation, parsed)) };
  };
  async function state(actor = context) {
    return withTenant(database.db, actor, async tx => {
      const result: Record<string, { count: number; hash: string }> = {};
      for (const table of ["inventory_procurement_requisitions", "inventory_purchase_orders", "inventory_purchase_order_versions", "inventory_procurement_commands",
        "finance_payable_bills", "finance_payable_payments", "finance_original_write_proofs", "finance_commands", "inventory_incoming_commands",
        "production_orders", "production_command_intents", "ad_goal_versions", "advertising_commands", "agent_command_requests", "audit_events", "ai_budget_ledger"])
        result[table] = (await tx.execute<{ count: number; hash: string }>(sql`select count(*)::int as count,
          md5(coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text)::text,'[]')) as hash from ${sql.identifier(table)} t`))[0]!;
      return result;
    });
  }
  return { source, ...owners, context, coworker, outsider, current, initialize, grant, procurementOriginal, billOriginal, incomingOriginal,
    advertisingOriginal, prepare, adopt, confirmation, receipt, state, restore: async () => { for (const actor of [context, coworker, outsider]) await grant(actor, commandPermissions); } };
}
