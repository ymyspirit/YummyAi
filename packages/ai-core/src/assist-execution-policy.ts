import { z } from "zod";
import {
  ASSIST_INSTRUCTIONS,
  ASSIST_MAX_OUTPUT_TOKENS,
  ASSIST_BENCHMARK_INSTRUCTIONS,
  ASSIST_ORDER_REQUIREMENTS_INSTRUCTIONS,
  assistPromptVersion,
  assistResultSchema,
  assistFingerprint,
} from "./assist.js";
import { ARTWORK_AUDIT_INSTRUCTIONS } from "./artwork-audit.js";

export function assistSystemInstructions(artworkAudit: boolean, benchmark = false, orderReview = false) {
  if (benchmark && orderReview) throw new Error("assist_execution_version_unsupported");
  return ASSIST_INSTRUCTIONS + (artworkAudit ? `\n${ARTWORK_AUDIT_INSTRUCTIONS}` : "") +
    (benchmark ? `\n${ASSIST_BENCHMARK_INSTRUCTIONS}` : "") + (orderReview ? `\n${ASSIST_ORDER_REQUIREMENTS_INSTRUCTIONS}` : "");
}

export function assistExecutionPolicy(artworkAudit: boolean, benchmark = false, orderReview = false, unlimited = false) {
  if (benchmark && unlimited) throw new Error("assist_execution_version_unsupported");
  return {
    contractVersion: unlimited ? "assist-execution-v2" : "assist-execution-v1",
    checksum: assistFingerprint({
      promptVersion: assistPromptVersion(benchmark, orderReview),
      systemInstructions: assistSystemInstructions(artworkAudit, benchmark, orderReview),
      maxOutputTokens: unlimited ? null : ASSIST_MAX_OUTPUT_TOKENS,
      outputSchema: z.toJSONSchema(assistResultSchema(benchmark, orderReview)),
    }),
  };
}
