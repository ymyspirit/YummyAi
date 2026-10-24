import { webcrypto } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FulfillmentCommandViewSchema } from "@yummyai/contracts/order/fulfillment-command";
import { createFulfillmentCommandIntent } from "./fulfillment-command-intent";
import {
  prepareFulfillmentCommand, actOnFulfillmentCommand, readFulfillmentCommand, readFulfillmentCommands, fulfillmentCommandDenied,
} from "./fulfillment-command-client";

const id = (value: number) => "019a0000-0000-7000-8000-" + value.toString(16).padStart(12, "0");
const authority = "synthetic exact current personal authority", date = "2026-10-23T00:00:00.000Z";
async function fixture() {
  const intent = await createFulfillmentCommandIntent(id(1), { kind: "delivery_feedback", targetId: id(2), packageId: id(3), requestId: id(4),
    input: { kind: "submitted", expectedSequence: 0, fileChecksum: "a".repeat(64), idempotencyKey: id(5), reference: "SYNTHETIC_UPLOAD_1",
      note: "Synthetic explicit original file submission evidence", occurredAt: date, verifiedByOperator: true } });
  const prepared = FulfillmentCommandViewSchema.parse({ id: id(6), requestId: intent.command.requestId, requestChecksum: intent.requestChecksum,
    kind: intent.command.kind, targetId: intent.command.targetId, orderId: intent.orderId, lineIds: [id(7)], status: "prepared",
    createdAt: date, expiresAt: "2027-01-01T00:00:00.000Z", leaseExpiresAt: null, acknowledged: false, canExecute: true, canCancel: true,
    summary: { orderNumber: "SYNTHETIC-ORDER", lineCount: 1, label: "Synthetic original factory receipt" }, receipt: null, errorCode: null });
  const succeeded = FulfillmentCommandViewSchema.parse({ ...prepared, status: "succeeded", canExecute: false, canCancel: false,
    receipt: { kind: "delivery_feedback", packageId: id(3), itemId: id(2), feedbackId: id(8), sequence: 1 } });
  return { intent, prepared, succeeded };
}
const response = (value: unknown, status = 200, stamp: string | null = authority) => new Response(JSON.stringify(value), {
  status, headers: { "content-type": "application/json", ...(stamp === null ? {} : { "x-yummyai-context-authority": stamp }) },
});

describe("same-order original fulfillment transport", () => {
  beforeEach(() => { vi.stubGlobal("crypto", webcrypto); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("binds the actual prepared201 to normalized original input while keeping coordinator and native request keys independent", async () => {
    const { intent, prepared } = await fixture(), fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(response(prepared, 201));
    vi.stubGlobal("fetch", fetcher);
    expect(intent.command.requestId).not.toBe(intent.command.kind === "production_milestone" ? intent.command.input.externalEventId : intent.command.input.idempotencyKey);
    expect(await prepareFulfillmentCommand(intent, authority)).toEqual(prepared);
    expect(fetcher.mock.calls[0]).toEqual(["/api/order-centers/fulfillment-commands", expect.objectContaining({ method: "POST", body: JSON.stringify(intent.command) })]);
    fetcher.mockResolvedValueOnce(response({ ...prepared, requestChecksum: "b".repeat(64) }, 201));
    await expect(prepareFulfillmentCommand(intent, authority)).rejects.toHaveProperty("status", 502);
    await expect(prepareFulfillmentCommand({ ...intent, requestChecksum: "c".repeat(64) }, authority)).rejects.toHaveProperty("status", 400);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("does not retry a lost execute and recovers only the exact same-order request through GET", async () => {
    const { intent, prepared, succeeded } = await fixture();
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError("Synthetic lost original execute response"))
      .mockResolvedValueOnce(response({ items: [succeeded], truncated: false })); vi.stubGlobal("fetch", fetcher);
    await expect(actOnFulfillmentCommand(prepared, "execute", authority, {}, intent)).rejects.toHaveProperty("status", 0);
    expect(await readFulfillmentCommands({ orderId: prepared.orderId, requestId: prepared.requestId, requestChecksum: prepared.requestChecksum }, authority))
      .toEqual({ items: [succeeded], truncated: false });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ method: "POST" }); expect(fetcher.mock.calls[0]?.[1]?.body).toBeUndefined();
    expect(fetcher.mock.calls[1]?.[1]).toMatchObject({ method: "GET" });
    expect(fetcher.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  });

  it("rejects another order substituted receipt or missing stamp and preserves literal authority denial without exposing upstream text", async () => {
    const { intent, prepared, succeeded } = await fixture(), fetcher = vi.fn<typeof fetch>(); vi.stubGlobal("fetch", fetcher);
    fetcher.mockResolvedValueOnce(response({ items: [{ ...prepared, orderId: id(20) }], truncated: false }));
    await expect(readFulfillmentCommands({ orderId: prepared.orderId }, authority)).rejects.toHaveProperty("status", 502);
    fetcher.mockResolvedValueOnce(response({ ...succeeded, receipt: { ...succeeded.receipt, itemId: id(21) } }));
    await expect(actOnFulfillmentCommand(prepared, "execute", authority, {}, intent)).rejects.toHaveProperty("status", 502);
    fetcher.mockResolvedValueOnce(response({ ...succeeded, lineIds: [id(22)] }));
    await expect(actOnFulfillmentCommand(prepared, "execute", authority)).rejects.toHaveProperty("status", 502);
    fetcher.mockResolvedValueOnce(response(prepared, 200, null));
    await expect(readFulfillmentCommand(prepared.id, prepared.orderId, authority)).rejects.toHaveProperty("code", "authority_changed");
    fetcher.mockResolvedValueOnce(response({ code: "authority_changed", message: "Synthetic private upstream text" }, 409));
    const failure = await readFulfillmentCommand(prepared.id, prepared.orderId, authority).catch(cause => cause);
    expect(fulfillmentCommandDenied(failure)).toBe(true); expect(String(failure)).not.toContain("Synthetic private upstream text");
    expect(fetcher).toHaveBeenCalledTimes(5);
  });

  it("rejects a completed old response after the current identity fence changes and never executes from a GET", async () => {
    const { prepared } = await fixture(); let isCurrent = true;
    const bytes = new TextEncoder().encode(JSON.stringify(prepared));
    const fetcher = vi.fn<typeof fetch>().mockImplementationOnce(async () => {
      const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes); isCurrent = false; controller.close(); } });
      return new Response(body, { status: 200, headers: { "content-type": "application/json", "x-yummyai-context-authority": authority } });
    }); vi.stubGlobal("fetch", fetcher);
    const options = { isCurrent: () => isCurrent };
    await expect(readFulfillmentCommand(prepared.id, prepared.orderId, authority, options)).rejects.toHaveProperty("code", "authority_changed");
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls.every(([, init]) => init?.method === "GET")).toBe(true);
  });
});
