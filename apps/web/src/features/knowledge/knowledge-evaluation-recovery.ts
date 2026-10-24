import { z } from "zod";
import { EntityIdSchema } from "@yummyai/contracts/common/ids";
import { StartKnowledgeEvaluationSchema } from "@yummyai/contracts/knowledge/governance";
import { canonicalJson } from "@yummyai/contracts/common/canonical-json";

export const evaluationRecoveryPrefix = "yummyai.knowledge-evaluation.start.v1:";
export const KnowledgeEvaluationIntentSchema = z.object({ version: z.literal(1), authority: z.string().min(1).max(65_536),
  caseId: EntityIdSchema, input: StartKnowledgeEvaluationSchema, runId: EntityIdSchema.nullable() }).strict();
export type KnowledgeEvaluationIntent = z.infer<typeof KnowledgeEvaluationIntentSchema>;
const key = (authority: string, caseId: string) => evaluationRecoveryPrefix + authority + ":" + caseId;

/** Only original IDs and the exact start body are retained, never questions,
 * answers, excerpts, credentials or model-provider keys. */
export function readEvaluationIntents(authority: string) {
  const found: KnowledgeEvaluationIntent[] = [];
  try {
    for (let index = sessionStorage.length - 1; index >= 0; index--) {
      const name = sessionStorage.key(index); if (!name?.startsWith(evaluationRecoveryPrefix)) continue;
      const text = sessionStorage.getItem(name);
      let parsed: unknown;
      try { parsed = text && text.length <= 128 * 1024 ? JSON.parse(text) : null; }
      catch { sessionStorage.removeItem(name); continue; }
      const value = KnowledgeEvaluationIntentSchema.safeParse(parsed);
      if (!value?.success || value.data.authority !== authority || name !== key(authority, value.data.caseId)) { sessionStorage.removeItem(name); continue; }
      found.push(value.data);
    }
  } catch { /* Unavailable storage never falls back to persisting private data. */ }
  return found;
}
export function clearEvaluationIntents(authority?: string) {
  try { for (let index = sessionStorage.length - 1; index >= 0; index--) {
    const name = sessionStorage.key(index);
    if (name?.startsWith(evaluationRecoveryPrefix) && (authority === undefined || name.startsWith(evaluationRecoveryPrefix + authority + ":"))) sessionStorage.removeItem(name);
  } } catch { /* Denial clears the in-memory state as well. */ }
}
export function saveEvaluationIntent(raw: KnowledgeEvaluationIntent) {
  const value = KnowledgeEvaluationIntentSchema.parse(raw), existing = readEvaluationIntents(value.authority).find(item => item.caseId === value.caseId);
  if (existing && (canonicalJson(existing.input) !== canonicalJson(value.input) || existing.runId !== null && existing.runId !== value.runId))
    throw new Error("仍有此问题的原评测请求 请先恢复原结果");
  const text = JSON.stringify(value); sessionStorage.setItem(key(value.authority, value.caseId), text);
  if (sessionStorage.getItem(key(value.authority, value.caseId)) !== text) throw new Error("原评测请求未能完整保存 本次未发送");
  return value;
}
export function removeEvaluationIntent(value: KnowledgeEvaluationIntent) {
  const current = readEvaluationIntents(value.authority).find(item => item.caseId === value.caseId);
  if (current && canonicalJson(current.input) === canonicalJson(value.input)) sessionStorage.removeItem(key(value.authority, value.caseId));
}
export async function evaluationRequestChecksum(value: KnowledgeEvaluationIntent) {
  const text = canonicalJson({ version: 1, operation: "knowledge-evaluation-start", caseId: value.caseId, input: value.input });
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}
