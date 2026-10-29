import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { OrderReviewAssistResultSchema } from "@yummyai/contracts/ai/assist";
import { assistHarness } from "./assist-harness.js";
import { assistSystemInstructions } from "./assist-execution-policy.js";
import { harnessChecksum } from "./harness-registry.js";

const sha256 = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
// Original dd7a528 describeSkill() values, captured with these exact permissions
// and policy. Includes instructions, input/output schemas, descriptors and pins.
// No Git command or mutable snapshot is consulted by the tests.
const oldMethods = [
  { kind: "creative", hash: "3d8908a04fd72140613353d497be1894f6e133a1d6a63aa1e2c53a46130af973" },
  { kind: "artwork_preflight", hash: "94e1ff3fd9ecbfbc14af2a14a7f066e407f04c4179479356055d141f3735357c" },
  { kind: "template_config", hash: "dfccd554d5325be8709249922875792416575519e549717333c00c8da765b3ba" },
  { kind: "sku_package", hash: "ac737cf43fedeae00f7a200cbd0e2377d22d1e09a3f36093cc875979b04ccb2e" },
  { kind: "business_review", hash: "5d2f64eb634699c159205346e71ae2cd8f27f26e3211c88bcf5565ecbb9470c1" },
  { kind: "procurement_review", hash: "a0d7c1f941e72f2f619110021b3e18c055cbf17fda7dde794528da5d47d943b6" },
  { kind: "after_sales_review", hash: "11daface5ed53cbf7b7ca24970160e04892d2b80e5db2d7e0fb2ab7f7749a50c" },
  { kind: "knowledge_answer", hash: "6fee72a6b341426944a11e86441c133c7f3c4c6b46deaa9797bf9da7b5b4eee5" },
] as const;

describe("Assist owner-specific harness compatibility", () => {
  it.each(oldMethods)("preserves the original $kind descriptor, instructions and execution checksum", ({ kind, hash }) => {
    const bundle = assistHarness(kind, false, ["fixture.read"], "fixture-policy-v1");
    const original = bundle.registry.describeSkill(bundle.skill);
    expect(bundle.skill.version).toBe("assist-method-2026-10-16-v1");
    expect(sha256(original)).toBe(hash);
    expect(original.executionContract).toEqual(bundle.registry.pin(bundle.skill));
    expect(original.tools[0]!.requiredPermissions).toEqual(["fixture.read"]);
  });

  it("preserves both the original artwork-audit method and the fixed benchmark contract", () => {
    const audit = assistHarness("artwork_preflight", true, ["fixture.read"], "fixture-policy-v1");
    expect(sha256(audit.registry.describeSkill(audit.skill)))
      .toBe("d8497a91103df6520a4352f5812dcf071d5550650f64dbd1b679323722dba819");
    const benchmark = assistHarness("knowledge_answer", false, ["fixture.read"], "fixture-policy-v1", true);
    const description = benchmark.registry.describeSkill(benchmark.skill);
    expect(benchmark.skill.version).toBe("assist-benchmark-2026-10-21-v1");
    expect(sha256(description)).toBe("5abe33a349a1edb50d5122b50d75e07976200b5b9ad3f3d2bc1a0e720a954620");
    expect(description.executionContract.checksum).toBe("34cb40a156823d9e738d11a3540345412e626a417f486d3d8a97dc03d7c2487a");
  });

  it("registers only order review with its separate v2 instructions, strict binding schema and new input pin", () => {
    const bundle = assistHarness("order_review", false, ["fixture.read"], "fixture-policy-v1");
    const description = bundle.registry.describeSkill(bundle.skill), contract = bundle.registry.pin(bundle.skill);
    expect(bundle.skill.version).toBe("assist-method-2026-10-27-v2");
    expect(description.instructions).toBe(assistSystemInstructions(false, false, true));
    expect(description.tools[0]!.outputSchemaChecksum).toBe(harnessChecksum(z.toJSONSchema(OrderReviewAssistResultSchema)));
    expect(description.tools[0]!.version).toBe(bundle.skill.version);
    expect(contract.checksum).not.toBe("cd3c7f2d8d2ef70f4d668bf30adf66d2792b5c06711a47efc4932a9e3cdf3970");
    expect(description.tools[0]!.effect).toBe("external_request");
    expect(description.tools[0]!.approval).toBe("owning_business_flow");
    expect(description.tools[0]!.requiredPermissions).toEqual(["fixture.read"]);
    const binding = { sourceFieldKey: "synthetic-original", targetFieldKey: "message", role: "text", confidence: 0.95,
      reason: "Matches the declared existing text field", evidence: [{ sourceId: "synthetic-source", detail: "Original field" }] };
    const output = { summary: "Synthetic classification", artworkChecks: [], findings: [], directions: [], matches: [],
      missingInformation: [], templateSlots: [], listingCopy: null, actions: [], replyDraft: null, orderFieldBindings: [binding] };
    expect(() => bundle.registry.checkOutput(contract, bundle.skill, bundle.toolKey, output)).not.toThrow();
    expect(() => bundle.registry.checkOutput(contract, bundle.skill, bundle.toolKey,
      { ...output, orderFieldBindings: [{ ...binding, value: "Invented customer text" }] })).toThrow("harness_tool_output_invalid");
    const ordinary = assistHarness("creative", false, ["fixture.read"], "fixture-policy-v1");
    expect(() => ordinary.registry.checkOutput(ordinary.registry.pin(ordinary.skill), ordinary.skill, ordinary.toolKey, output))
      .toThrow("harness_tool_output_invalid");
    expect(() => assistHarness("order_review", false, ["fixture.read"], "fixture-policy-v1", true))
      .toThrow("assist_execution_version_unsupported");
  });
});
