import { HarnessContractError, HarnessRegistry, harnessChecksum, type SecretVault } from "@yummyai/ai-core";
import { ForbiddenError, intersectPermissionContexts, erpPermissionContext, permissionScope, Permission, type PermissionValue } from "@yummyai/authz";
import type { TenantContext } from "@yummyai/contracts";
import { erpSessionAuthority } from "@yummyai/contracts/auth/session";
import { AGENT_READ_VERSION, AgentBalancePageInputSchema, AgentBalancePageViewSchema, AgentExceptionPageInputSchema, AgentExceptionPageViewSchema,
  AgentReadCallSchema, AgentReadPageViewSchema, AgentReadWorkspaceSchema, type AgentReadOwnerPage, type AgentReadToolKey } from "@yummyai/contracts/ai/agent-read";
import { loadCurrentMembershipContext, withTenant, type DatabaseConnection } from "@yummyai/database";
import { z } from "zod";
import { sharedAgentReadAuthority as currentAgentReadAuthority, readOrderExceptionPage, readInventoryBalancePage, AgentReadGatewayError } from "./agent-read-owner.js";

const skill = { key: "erp.agent.read", version: AGENT_READ_VERSION } as const;
const bits: Record<AgentReadToolKey, PermissionValue> = { "orders.exceptions.page": Permission.OrderRead, "inventory.balances.page": Permission.InventoryRead };
const descriptor = (key: AgentReadToolKey, owner: string, label: string) => ({ key, owner, label, version: AGENT_READ_VERSION,
  effect: "read" as const, inputSchemaKey: key + ".input", outputSchemaKey: key + ".output", permissionPolicyVersion: AGENT_READ_VERSION,
  requiredPermissions: [bits[key]], resourcePolicy: "active-member.tenant-owner-projection", dataDomains: ["business" as const],
  timeout: { mode: "abort_signal" as const, milliseconds: 15_000 }, maxInputBytes: 16_384, maxOutputBytes: 1_048_576,
  recovery: "owner_receipt" as const, approval: "owning_business_flow" as const });
export const agentReadHarness = new HarnessRegistry("erp.agent.read", [
  { descriptor: descriptor("orders.exceptions.page", "orders", "订单异常元数据"), inputSchema: AgentExceptionPageInputSchema, outputSchema: AgentExceptionPageViewSchema },
  { descriptor: descriptor("inventory.balances.page", "inventory", "库存余额"), inputSchema: AgentBalancePageInputSchema, outputSchema: AgentBalancePageViewSchema },
], [{ ...skill, label: "ERP 业务资料读取", instructions: "只读取当前成员获准的原业务资料。沿原游标逐页读取，集合变化后重新读取；未到最后一页不得声称完整。不得执行任何业务写入或模型调用。",
  steps: ["核对当前身份与工具契约", "调用原业务 owner 的授权读取", "复核资料集合与最终权限"], tools: Object.keys(bits).map(key => ({ key, version: AGENT_READ_VERSION })) }]);

const Cursor = z.object({ version: z.literal(1), tool: z.enum(["orders.exceptions.page", "inventory.balances.page"]),
  tenantId: z.uuidv7(), actorId: z.uuidv7(), authorityChecksum: z.string().regex(/^[a-f0-9]{64}$/),
  contractChecksum: z.string().regex(/^[a-f0-9]{64}$/), queryChecksum: z.string().regex(/^[a-f0-9]{64}$/),
  collectionFingerprint: z.string().regex(/^[a-f0-9]{64}$/), after: z.string().min(1).max(200), total: z.int().nonnegative(),
  readCount: z.int().positive(), expiresAt: z.iso.datetime() }).strict();
const changed = () => new AgentReadGatewayError(409, "agent_collection_changed", "资料已变化 请从第一页重新读取");
const active = (signal: AbortSignal) => { if (signal.aborted) throw new AgentReadGatewayError(408, "agent_read_timeout", "读取已超时 请重新读取"); };

export class SharedAgentReadGateway {
  constructor(private readonly database: DatabaseConnection, private readonly vault: SecretVault,
    private readonly owners = { orderPage: (...args: Parameters<typeof readOrderExceptionPage> extends [DatabaseConnection,...infer R] ? R : never) => readOrderExceptionPage(database,...args),
      balancePage: (...args: Parameters<typeof readInventoryBalancePage> extends [DatabaseConnection,...infer R] ? R : never) => readInventoryBalancePage(database,...args) }) {}

  async workspace(context: TenantContext) {
    const current = await withTenant(this.database.db, context, async tx =>
      intersectPermissionContexts(context, await loadCurrentMembershipContext(tx, context, { lock: true })), { isolationLevel: "repeatable read", accessMode: "read write" });
    if (!current.permissions.length) throw new ForbiddenError(Permission.OrderRead);
    const executionContract = agentReadHarness.pin(skill);
    return AgentReadWorkspaceSchema.parse({ version: AGENT_READ_VERSION, contextAuthority: erpSessionAuthority(erpPermissionContext(current)), executionContract,
      mcpState: "not_connected", tools: (Object.keys(bits) as AgentReadToolKey[]).map(key => ({ key, minimumScope: "tenant",
        available: current.permissions.includes(bits[key]) && permissionScope(current, bits[key]) === "tenant",
        descriptor: agentReadHarness.descriptor(executionContract, skill, key) })) });
  }

  async call(context: TenantContext, raw: unknown) {
    const parsed = AgentReadCallSchema.safeParse(raw);
    if (!parsed.success) throw new AgentReadGatewayError(400, "agent_read_input_invalid", "读取参数无法核对");
    const call = parsed.data, signal = AbortSignal.timeout(15_000);
    try { agentReadHarness.checkInput(call.executionContract, skill, call.tool, call.input); }
    catch (error) { if (!(error instanceof HarnessContractError)) throw error;
      throw new AgentReadGatewayError(409, error.code, "工具契约已变化 请重新读取能力列表"); }
    const admission = await this.current(context, bits[call.tool]), authority = erpSessionAuthority(admission);
    const { cursor: transportCursor, ...query } = call.input;
    const binding = { tenantId: context.tenantId, actorId: context.userId, tool: call.tool, authorityChecksum: harnessChecksum(authority),
      contractChecksum: call.executionContract.checksum, queryChecksum: harnessChecksum(query) };
    let cursor: z.infer<typeof Cursor> | null = null;
    if (transportCursor) {
      try { cursor = await this.vault.withSecret(transportCursor, text => Cursor.parse(JSON.parse(text))); }
      catch { throw new AgentReadGatewayError(409, "agent_cursor_invalid", "原游标无法核对 请从第一页重新读取"); }
      if (Object.entries(binding).some(([key, value]) => cursor![key as keyof typeof binding] !== value) || cursor.expiresAt <= new Date().toISOString()) throw changed();
    }
    active(signal);
    const position = cursor ? { after: cursor.after, collectionFingerprint: cursor.collectionFingerprint } : null;
    const page: AgentReadOwnerPage<unknown> = call.tool === "orders.exceptions.page"
      ? await this.owners.orderPage(admission, call.input, position, signal)
      : await this.owners.balancePage(admission, call.input, position, signal);
    active(signal);
    if (cursor && (page.collectionFingerprint !== cursor.collectionFingerprint || page.total !== cursor.total)) throw changed();
    const readCount = (cursor?.readCount ?? 0) + page.items.length;
    if (readCount > page.total || page.items.length > call.input.pageSize || page.hasMore && (!page.items.length || !page.lastKey || readCount >= page.total)
      || !page.hasMore && readCount !== page.total) throw changed();
    const final = await this.current(context, bits[call.tool]);
    if (erpSessionAuthority(final) !== authority) throw new AgentReadGatewayError(409, "authority_changed", "当前权限或资料范围已变化");
    active(signal);
    const nextCursor = page.hasMore ? this.vault.encrypt(JSON.stringify(Cursor.parse({ version: 1, ...binding, after: page.lastKey,
      collectionFingerprint: page.collectionFingerprint, total: page.total, readCount,
      expiresAt: cursor?.expiresAt ?? new Date(Date.now() + 15 * 60_000).toISOString() }))) : null;
    const output = AgentReadPageViewSchema.parse({ version: AGENT_READ_VERSION, effect: "read", tool: call.tool,
      contextAuthority: erpSessionAuthority(erpPermissionContext(admission)), checkedAt: page.checkedAt, collectionFingerprint: page.collectionFingerprint, total: page.total,
      readCount, consistency: "unchanged_collection", complete: !page.hasMore, nextCursor, query: call.input, items: page.items });
    agentReadHarness.checkOutput(call.executionContract, skill, call.tool, output);
    return output;
  }

  private current(context: TenantContext, bit: PermissionValue) {
    return withTenant(this.database.db, context, tx => currentAgentReadAuthority(tx, context, bit), { isolationLevel: "repeatable read", accessMode: "read write" });
  }
}
