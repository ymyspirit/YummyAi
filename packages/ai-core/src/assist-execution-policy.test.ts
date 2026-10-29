import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { BenchmarkAssistResultSchema, LegacyAssistResultSchema, OrderReviewAssistResultSchema } from "@yummyai/contracts/ai/assist";
import { ASSIST_INSTRUCTIONS, ASSIST_PROMPT_VERSION, ASSIST_ORDER_REQUIREMENTS_VERSION, ASSIST_BENCHMARK_PROMPT_VERSION,
  ASSIST_ORDER_REQUIREMENTS_INSTRUCTIONS, assistPromptVersion, assistResultSchema } from "./assist.js";
import { assistExecutionPolicy, assistSystemInstructions } from "./assist-execution-policy.js";
import { assistHarness } from "./assist-harness.js";

describe("Assist execution contract selection", () => {
  it.each([
    { audit: false, benchmark: false, checksum: "5dd962f90e94cb1bf38dcacb630758d0e9e3cbab695d4ad768cf5b00da54bae9" },
    { audit: true, benchmark: false, checksum: "40d2a433898f1475f70347e381f706c4b6f75b161275b336bdb0a950ae7fdecc" },
    { audit: false, benchmark: true, checksum: "26933c370708853646b6a53588a6a6876c30f970049ca29d13f67b38d47a190b" },
  ])("keeps dd7a528 policy bytes with audit=$audit and benchmark=$benchmark", ({ audit, benchmark, checksum }) => {
    // Frozen original policy checksums; runtime tests do not load Git history.
    expect(assistExecutionPolicy(audit, benchmark)).toEqual({ contractVersion: "assist-execution-v1", checksum });
    expect(assistExecutionPolicy(audit, benchmark, false)).toEqual(assistExecutionPolicy(audit, benchmark));
  });

  it("preserves the original base prompt and default selectors for non-order owners", () => {
    expect(ASSIST_PROMPT_VERSION).toBe("erp-assist-2026-10-06-v6");
    expect(createHash("sha256").update(JSON.stringify(ASSIST_INSTRUCTIONS)).digest("hex"))
      .toBe("81ac7a37065a195c0f99aa045922e685f3c9fd75ea1a8c4a8a4a034ac3779250");
    expect(assistPromptVersion()).toBe(ASSIST_PROMPT_VERSION);
    expect(assistResultSchema()).toBe(LegacyAssistResultSchema);
    expect(assistSystemInstructions(false)).toBe(ASSIST_INSTRUCTIONS);
    expect(assistPromptVersion(true)).toBe(ASSIST_BENCHMARK_PROMPT_VERSION);
    expect(assistResultSchema(true)).toBe(BenchmarkAssistResultSchema);
    expect(assistSystemInstructions(false, true)).not.toContain(ASSIST_ORDER_REQUIREMENTS_INSTRUCTIONS);
  });

  it("keeps the original BASE v6 while pinning the versioned order supplement, v2 method and complete policy", () => {
    expect(assistPromptVersion(false, true)).toBe("erp-assist-2026-10-06-v6");
    expect(ASSIST_ORDER_REQUIREMENTS_VERSION).toBe("order-requirements-2026-10-27-v1");
    expect(ASSIST_ORDER_REQUIREMENTS_INSTRUCTIONS.split("\n")[0]).toBe(ASSIST_ORDER_REQUIREMENTS_VERSION);
    expect(assistResultSchema(false, true)).toBe(OrderReviewAssistResultSchema);
    const bundle = assistHarness("order_review", false, ["fixture.read"], "fixture-policy-v1");
    expect(bundle.skill.version).toBe("assist-method-2026-10-27-v2");
    const instructions = bundle.registry.instructions(bundle.registry.pin(bundle.skill), bundle.skill);
    expect(instructions).toBe(ASSIST_INSTRUCTIONS + "\n" + ASSIST_ORDER_REQUIREMENTS_INSTRUCTIONS);
    expect(assistSystemInstructions(false, false, true)).toBe(instructions);
    const policy = assistExecutionPolicy(false, false, true);
    expect(policy).toEqual({ contractVersion: "assist-execution-v1", checksum: createHash("sha256").update(JSON.stringify({
      promptVersion: "erp-assist-2026-10-06-v6", systemInstructions: instructions,
      maxOutputTokens: 6000, outputSchema: z.toJSONSchema(OrderReviewAssistResultSchema),
    })).digest("hex") });
    expect(policy.checksum).not.toBe(assistExecutionPolicy(false).checksum);
  });

  it("rejects a contradictory benchmark-plus-order selection in every shared selector", () => {
    expect(() => assistPromptVersion(true, true)).toThrow("assist_execution_version_unsupported");
    expect(() => assistResultSchema(true, true)).toThrow("assist_execution_version_unsupported");
    expect(() => assistSystemInstructions(false, true, true)).toThrow("assist_execution_version_unsupported");
    expect(() => assistExecutionPolicy(false, true, true)).toThrow("assist_execution_version_unsupported");
  });
  it("pins a distinct unlimited output policy without changing old frozen executions", () => {
    const policy = assistExecutionPolicy(false, false, true, true);
    expect(policy).toEqual({ contractVersion: "assist-execution-v2", checksum: createHash("sha256").update(JSON.stringify({
      promptVersion: "erp-assist-2026-10-06-v6", systemInstructions: assistSystemInstructions(false, false, true),
      maxOutputTokens: null, outputSchema: z.toJSONSchema(OrderReviewAssistResultSchema),
    })).digest("hex") });
    expect(policy.checksum).not.toBe(assistExecutionPolicy(false, false, true).checksum);
    expect(() => assistExecutionPolicy(false, true, false, true)).toThrow("assist_execution_version_unsupported");
  });
});
