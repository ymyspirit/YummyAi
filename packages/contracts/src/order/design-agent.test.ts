import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createEntityId } from "../common/ids.js";
import { OrderDesignRestoreResponseSchema } from "./design-agent.js";

const input = () => ({ runId: createEntityId(), stepId: createEntityId(), requestId: createEntityId(), expectedRevision: 1,
  idempotencyKey: randomUUID(), contentBase64: Buffer.from("synthetic bytes").toString("base64"),
  providerReference: "provider-record-001", verificationNote: "Operator verified original request and result", verifiedOriginalResult: true });

describe("verified provider-result recovery contract", () => {
  it("requires operator verification and never accepts a caller supplied invoice, model or source rewrite", () => {
    expect(OrderDesignRestoreResponseSchema.safeParse(input()).success).toBe(true);
    expect(OrderDesignRestoreResponseSchema.safeParse({ ...input(), verifiedOriginalResult: false }).success).toBe(false);
    for (const injected of [{ actualCostUsd: 0 }, { model: "different-model" }, { sourceVersionId: createEntityId() }, { objectKey: "private/path" }])
      expect(OrderDesignRestoreResponseSchema.safeParse({ ...input(), ...injected }).success).toBe(false);
  });
  it("bounds private image payloads and rejects whitespace, invalid base64 and empty evidence", () => {
    for (const contentBase64 of ["", "a", "abcde===", "a b=", "\ndata:image/png;base64,AAAA", "A".repeat(28 * 1024 * 1024)])
      expect(OrderDesignRestoreResponseSchema.safeParse({ ...input(), contentBase64 }).success).toBe(false);
    expect(OrderDesignRestoreResponseSchema.safeParse({ ...input(), providerReference: " ", verificationNote: "too short" }).success).toBe(false);
  });
});
