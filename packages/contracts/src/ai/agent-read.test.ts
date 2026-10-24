import { describe, expect, it } from "vitest";
import { createEntityId } from "../common/ids.js";
import { AgentBalanceItemSchema, AgentReadCallSchema, AgentExceptionItemSchema } from "./agent-read.js";

const hash = "a".repeat(64);
const executionContract = { contractVersion: "native-harness-v1", executorKey: "erp.agent.read",
  skill: { key: "erp.agent.read", version: "erp-agent-read-v1", checksum: hash },
  tools: [{ key: "inventory.balances.page", version: "erp-agent-read-v1", checksum: hash }], checksum: hash };

describe("Agent read transport boundaries", () => {
  it("admits only the two read tools and rejects writes, caller authority and excess paging fields", () => {
    const call = { version: "erp-agent-read-v1", tool: "inventory.balances.page", executionContract, input: {} };
    expect(AgentReadCallSchema.parse(call).input).toEqual({ pageSize: 25, cursor: null });
    expect(AgentReadCallSchema.safeParse({ ...call, tool: "inventory.recordMovement" }).success).toBe(false);
    expect(AgentReadCallSchema.safeParse({ ...call, tenantId: createEntityId() }).success).toBe(false);
    for (const input of [{ pageSize: 0 }, { pageSize: 101 }, { pageSize: 25, after: createEntityId() }, { confirmed: true }])
      expect(AgentReadCallSchema.safeParse({ ...call, input }).success).toBe(false);
  });

  it("preserves the inventory owner's exact wire quantities and rejects unsupported precision", () => {
    const value = { id: createEntityId(), dimensionKey: "synthetic_dimension", stockItemId: createEntityId(), locationId: createEntityId(),
      lotId: null, unit: "meter", physicalQuantity: "1.000000001", reservedQuantity: "0.000000001", availableQuantity: 1,
      inTransitQuantity: 0, providerQuantity: 0, virtualQuantity: 0, projectionVersion: 1, updatedAt: "2026-10-22T00:00:00.000Z" };
    expect(AgentBalanceItemSchema.parse(value)).toEqual(value);
    for (const physicalQuantity of ["0.0000000001", "1e-9", Number.NaN, Number.POSITIVE_INFINITY])
      expect(AgentBalanceItemSchema.safeParse({ ...value, physicalQuantity }).success).toBe(false);
  });

  it("keeps order-exception projections metadata only even when a private field is injected", () => {
    const value = { id: createEntityId(), orderId: createEntityId(), category: "address", status: "open", eventMissing: false,
      eventId: createEntityId(), sequence: 1, orderSequence: 2, openedAt: "2026-10-22T00:00:00.000Z", resolvedAt: null, sourceChecksum: hash };
    expect(AgentExceptionItemSchema.parse(value)).toEqual(value);
    for (const field of ["message", "resolution", "customerName", "externalOrderId"])
      expect(AgentExceptionItemSchema.safeParse({ ...value, [field]: "Synthetic private value" }).success).toBe(false);
  });
});
