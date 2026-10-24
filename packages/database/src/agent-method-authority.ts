import { createHash } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import { canonicalJson } from "@yummyai/contracts/common/canonical-json";
import {
  AgentMethodDefinitionSchema,
  AgentMethodSelectionSchema,
  type AgentMethodDefinition,
  type RegisteredAgentMethod,
} from "@yummyai/contracts/harness/methods";
import {
  agentMethods as methods,
  agentMethodVersions as versions,
  agentMethodEvents as events,
} from "./schema/agent-methods.js";
import type { TenantTransaction } from "./tenant-transaction.js";

type RegisteredMethod = RegisteredAgentMethod;
export const methodDefinitionChecksum = (value: unknown) =>
  createHash("sha256").update(canonicalJson(value)).digest("hex");
export class AgentMethodAuthorityError extends Error {
  constructor(
    readonly code:
      | "assist_method_unavailable"
      | "assist_method_withdrawn"
      | "assist_method_snapshot_missing"
      | "assist_method_changed"
      | "assist_method_sources_unavailable",
  ) {
    super(code);
    this.name = "AgentMethodAuthorityError";
  }
}
function validateDefinition(
  raw: unknown,
  checksum: string,
  registered: RegisteredMethod,
): AgentMethodDefinition {
  const parsed = AgentMethodDefinitionSchema.safeParse(raw);
  if (!parsed.success || methodDefinitionChecksum(parsed.data) !== checksum)
    throw new AgentMethodAuthorityError("assist_method_changed");
  const { methodKey, label, instructions, steps, executionContract, tools } = parsed.data;
  const definition = { methodKey, label, instructions, steps, executionContract, tools };
  if (methodDefinitionChecksum(definition) !== methodDefinitionChecksum(registered))
    throw new AgentMethodAuthorityError("assist_method_changed");
  return parsed.data;
}

/** Metadata reads only. Caller owns withTenant(), current permissions and source validity. */
export async function selectAgentMethod(tx: TenantTransaction, registered: RegisteredMethod, options: { supported?: readonly RegisteredMethod[] } = {}) {
  const [method] = await tx
    .select()
    .from(methods)
    .where(eq(methods.methodKey, registered.methodKey));
  if (!method?.adoptedAt)
    return {
      selection: AgentMethodSelectionSchema.parse({
        schemaVersion: "agent-method-selection-v1",
        mode: "builtin",
        methodKey: registered.methodKey,
        contractChecksum: registered.executionContract.checksum,
        withdrawalGeneration: method?.withdrawalGeneration ?? 0,
      }),
      definition: null,
    };
  if (method.disabledAt || method.activeVersion === null)
    throw new AgentMethodAuthorityError("assist_method_withdrawn");
  const [version] = await tx
    .select()
    .from(versions)
    .where(and(eq(versions.methodId, method.id), eq(versions.version, method.activeVersion)));
  const [publication] = await tx
    .select()
    .from(events)
    .where(
      and(
        eq(events.methodId, method.id),
        eq(events.version, method.activeVersion),
        eq(events.action, "publish"),
      ),
    )
    .orderBy(desc(events.revision))
    .limit(1);
  if (!version || !publication) throw new AgentMethodAuthorityError("assist_method_unavailable");
  const candidates = [registered, ...(options.supported ?? [])].filter(candidate => candidate.methodKey === registered.methodKey);
  const selected = candidates.find(candidate => candidate.executionContract.checksum === version.definition.executionContract?.checksum);
  if (!selected) throw new AgentMethodAuthorityError("assist_method_changed");
  const definition = validateDefinition(version.definition, version.checksum, selected);
  const selection = AgentMethodSelectionSchema.parse({
    schemaVersion: "agent-method-selection-v1",
    mode: "published",
    methodKey: method.methodKey,
    contractChecksum: selected.executionContract.checksum,
    withdrawalGeneration: method.withdrawalGeneration,
    methodId: method.id,
    versionId: version.id,
    version: version.version,
    checksum: version.checksum,
    publicationEventId: publication.id,
  });
  return { selection, definition };
}

export async function assertAgentMethodSelection(
  tx: TenantTransaction,
  registered: RegisteredMethod,
  raw: unknown,
  options: { lock?: boolean; admission?: boolean } = {},
) {
  if (options.lock)
    await tx.execute(
      sql`select pg_advisory_xact_lock_shared(hashtextextended('method:'||current_setting('app.tenant_id')||':'||${registered.methodKey},0))`,
    );
  const query = tx.select().from(methods).where(eq(methods.methodKey, registered.methodKey));
  const [method] = await (options.lock ? query.for("share") : query);
  if (!raw) {
    if (method?.adoptedAt) throw new AgentMethodAuthorityError("assist_method_snapshot_missing");
    return { selection: null, definition: null };
  }
  const parsed = AgentMethodSelectionSchema.safeParse(raw);
  if (!parsed.success) throw new AgentMethodAuthorityError("assist_method_changed");
  const pin = parsed.data;
  if (
    pin.methodKey !== registered.methodKey ||
    pin.contractChecksum !== registered.executionContract.checksum
  )
    throw new AgentMethodAuthorityError("assist_method_changed");
  if (method?.disabledAt || (method?.withdrawalGeneration ?? 0) !== pin.withdrawalGeneration)
    throw new AgentMethodAuthorityError("assist_method_withdrawn");
  if (pin.mode === "builtin") {
    if (options.admission && method?.adoptedAt)
      throw new AgentMethodAuthorityError("assist_method_changed");
    return { selection: pin, definition: null };
  }
  if (
    !method?.adoptedAt ||
    method.id !== pin.methodId ||
    method.activeVersion === null ||
    (options.admission && method.activeVersion !== pin.version)
  )
    throw new AgentMethodAuthorityError("assist_method_changed");
  const [version] = await tx
    .select()
    .from(versions)
    .where(
      and(
        eq(versions.methodId, method.id),
        eq(versions.id, pin.versionId),
        eq(versions.version, pin.version),
      ),
    );
  const [publication] = await tx
    .select()
    .from(events)
    .where(
      and(
        eq(events.id, pin.publicationEventId),
        eq(events.methodId, method.id),
        eq(events.version, pin.version),
        eq(events.action, "publish"),
      ),
    );
  if (!version || !publication || version.checksum !== pin.checksum)
    throw new AgentMethodAuthorityError("assist_method_changed");
  return {
    selection: pin,
    definition: validateDefinition(version.definition, version.checksum, registered),
  };
}
