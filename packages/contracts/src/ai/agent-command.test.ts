import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createEntityId } from "../common/ids.js";
import { ProcurementCommandKindSchema } from "../procurement/procurement-command.js";
import { IncomingCommandKindSchema } from "../procurement/incoming-command.js";
import { FinanceCommandKindSchema } from "../finance/finance-command.js";
import { AdCommandKindSchema } from "../customer-intelligence/advertising-command.js";
import { ProductionCommandKindSchema } from "../order/production-command.js";
import { AGENT_COMMAND_VERSION, AgentCommandIntentSchema, AgentCommandReceiptSchema, AgentCommandOwnerSnapshotSchema,
  AgentCommandViewSchema, AgentCommandConfirmationSchema, ConfirmAgentCommandSchema, PrepareAgentCommandSchema, AdoptAgentCommandSchema,
  canonicalAgentCommandRequest, canonicalAgentCommandOriginal } from "./agent-command.js";

const id = createEntityId(), requestId = randomUUID(), hash = "a".repeat(64), date = "2026-10-22T00:00:00.000Z";
const original = () => ({ domain: "procurement" as const, command: { kind: "requisition_create" as const, targetId: null,
  input: { code: "SYNTHETIC-REQ", reasonCode: "SYNTHETIC", lines: [{ lineKey: "L1", stockItemId: createEntityId(),
    destinationLocationId: createEntityId(), quantity: "2.5", unit: "gram" as const }], idempotencyKey: "synthetic-original-key" } } });
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const snapshot = () => {
  const saved = original();
  return { reference: { domain: "procurement", commandId: id, accountId: null }, original: saved,
    native: { domain: "procurement", view: { id, kind: "requisition_create", targetId: null, targetLabel: "Synthetic requisition", targetDetail: null,
      status: "prepared", createdAt: date, expiresAt: "2026-10-29T00:00:00.000Z", completedAt: null,
      contextAuthority: "synthetic-current-personal-authority", acknowledged: false, canExecute: true, canCancel: true,
      original: saved.command, result: null, blockReason: null } } };
};

describe("original-owner Agent command protocol", () => {
  it("retains five original schema families and all37 actual kinds without creating a model write action", () => {
    const all = [ProcurementCommandKindSchema, IncomingCommandKindSchema, ProductionCommandKindSchema, FinanceCommandKindSchema, AdCommandKindSchema];
    expect(all.map(schema => schema.options.length)).toEqual([9, 6, 3, 12, 7]);
    expect(all.reduce((sum, schema) => sum + schema.options.length, 0)).toBe(37);
    expect(PrepareAgentCommandSchema.safeParse({ version: AGENT_COMMAND_VERSION, requestId, original: { domain: "sql", command: {} } }).success).toBe(false);
    expect(PrepareAgentCommandSchema.safeParse({ version: AGENT_COMMAND_VERSION, requestId, original: original(), autoConfirm: true }).success).toBe(false);
  });

  it("binds operation, full original owner input and authored key while normalizing only through the owner contract", () => {
    const source = original(), body = { version: AGENT_COMMAND_VERSION, requestId, original: source };
    const text = canonicalAgentCommandRequest("prepare", body), parsed = JSON.parse(text);
    expect(parsed).toMatchObject({ operation: "prepare", request: { requestId, original: { domain: "procurement", command: { input: { idempotencyKey: source.command.input.idempotencyKey } } } } });
    expect(canonicalAgentCommandRequest("prepare", { original: source, requestId, version: AGENT_COMMAND_VERSION })).toBe(text);
    expect(sha(canonicalAgentCommandRequest("prepare", { ...body, original: { ...source,
      command: { ...source.command, input: { ...source.command.input, lines: [{ ...source.command.input.lines[0]!, quantity: "2.6" }] } } } }))).not.toBe(sha(text));
    expect(canonicalAgentCommandOriginal(source)).toContain("synthetic-original-key");
    const adopt = { version: AGENT_COMMAND_VERSION, requestId, reference: { domain: "procurement", commandId: id, accountId: null } };
    expect(AdoptAgentCommandSchema.parse(adopt)).toEqual(adopt);
    expect(sha(canonicalAgentCommandRequest("adopt", adopt))).not.toBe(sha(text));
    expect(AdoptAgentCommandSchema.safeParse({ ...adopt, original: source }).success).toBe(false);
  });

  it("requires an exact native reference and an explicit confirmation with no caller-selected authority", () => {
    const value = snapshot(); expect(AgentCommandOwnerSnapshotSchema.safeParse(value).success).toBe(true);
    expect(AgentCommandOwnerSnapshotSchema.safeParse({ ...value, reference: { ...value.reference, commandId: createEntityId() } }).success).toBe(false);
    const confirm = { version: AGENT_COMMAND_VERSION, requestId, ownerCommandId: id, originalChecksum: hash,
      confirmationToken: "synthetic-encrypted-confirmation", decision: "execute_original" };
    expect(ConfirmAgentCommandSchema.parse(confirm)).toEqual(confirm);
    const serverToken = { version: AGENT_COMMAND_VERSION, id, requestId, tenantId: createEntityId(), userId: createEntityId(), ownerCommandId: id,
      originalChecksum: hash, ceilingChecksum: hash, currentAuthority: hash, issuedAt: date, expiresAt: "2026-10-22T00:05:00.000Z" };
    expect(AgentCommandConfirmationSchema.parse(serverToken)).toEqual(serverToken);
    expect(AgentCommandConfirmationSchema.safeParse({ ...serverToken, currentAuthority: "raw full personal authority" }).success).toBe(false);
    for (const invalid of [{ ...confirm, decision: "approve_all" }, { ...confirm, tenantId: createEntityId() }, { ...confirm, originalChecksum: "short" },
      { ...confirm, confirmed: true }, { ...confirm, permissionScopes: {} }]) expect(ConfirmAgentCommandSchema.safeParse(invalid).success).toBe(false);
  });

  it("does not turn a missing receipt or a private-free view into an executable confirmation", () => {
    const receipt = { version: AGENT_COMMAND_VERSION, requestId, requestChecksum: hash, disposition: "not_found", id: null, ownerCommandId: null,
      contextAuthority: "synthetic-authority", privateAvailable: false };
    expect(AgentCommandReceiptSchema.safeParse(receipt).success).toBe(true);
    expect(AgentCommandReceiptSchema.safeParse({ ...receipt, id }).success).toBe(false);
    const view = { version: AGENT_COMMAND_VERSION, id, requestId, requestChecksum: hash, contextAuthority: "synthetic-authority",
      domain: "procurement", kind: "requisition_create", ownerCommandId: id, createdAt: date, expiresAt: "2026-10-29T00:00:00.000Z",
      executeRequestedAt: null, cancelledAt: null, state: "prepared", privateAvailable: true, snapshot: snapshot(), originalChecksum: hash,
      confirmationToken: "synthetic-confirmation", confirmationExpiresAt: "2026-10-22T00:05:00.000Z", canConfirm: true, canCancel: true, errorCode: null };
    expect(AgentCommandViewSchema.safeParse(view).success).toBe(true);
    for (const invalid of [{ ...view, privateAvailable: false }, { ...view, confirmationToken: null }, { ...view, state: "succeeded" },
      { ...view, snapshot: null }, { ...view, canConfirm: false }]) expect(AgentCommandViewSchema.safeParse(invalid).success).toBe(false);
  });

  it("persists only seven scalar recovery fields and rejects the original body, secret token or authority in storage", () => {
    const value = { version: 1, ownerScope: hash, requestId, requestChecksum: hash, id: null, state: "unknown", createdAt: date };
    expect(AgentCommandIntentSchema.safeParse(value).success).toBe(true);
    expect(Object.keys(AgentCommandIntentSchema.parse(value))).toHaveLength(7);
    for (const privateField of ["original", "confirmationToken", "authority", "rawRequestKey"])
      expect(AgentCommandIntentSchema.safeParse({ ...value, [privateField]: "synthetic-private" }).success).toBe(false);
  });
});
