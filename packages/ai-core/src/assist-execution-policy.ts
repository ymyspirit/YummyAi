import { z } from "zod";
import { AssistResultSchema, LegacyAssistResultSchema } from "@yummyai/contracts/ai/assist";
import {
  ASSIST_INSTRUCTIONS,
  ASSIST_MAX_OUTPUT_TOKENS,
  ASSIST_PROMPT_VERSION,
  ASSIST_BENCHMARK_PROMPT_VERSION,
  ASSIST_BENCHMARK_INSTRUCTIONS,
  assistFingerprint,
} from "./assist.js";
import { ARTWORK_AUDIT_INSTRUCTIONS } from "./artwork-audit.js";

export function assistExecutionPolicy(artworkAudit: boolean, benchmark = false) {
  return {
    contractVersion: "assist-execution-v1",
    checksum: assistFingerprint({
      promptVersion: benchmark ? ASSIST_BENCHMARK_PROMPT_VERSION : ASSIST_PROMPT_VERSION,
      systemInstructions:
        ASSIST_INSTRUCTIONS + (artworkAudit ? `\n${ARTWORK_AUDIT_INSTRUCTIONS}` : "") + (benchmark ? `\n${ASSIST_BENCHMARK_INSTRUCTIONS}` : ""),
      maxOutputTokens: ASSIST_MAX_OUTPUT_TOKENS,
      outputSchema: z.toJSONSchema(benchmark ? AssistResultSchema : LegacyAssistResultSchema),
    }),
  };
}
