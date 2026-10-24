import { AssistViewSchema, CreateAssistSchema, type AssistKind, type AssistView, type CreateAssist } from "@yummyai/contracts/ai/assist";
import { assistRequestRecoveryText, type AssistIntent } from "@yummyai/contracts/ai/assist-recovery";
import { AssistRequestError } from "./assist-client";
import { assistIntentHash, readAssistIntents, recordAssistIntentRun } from "./assist-request-intent";

export type AssistEntryVerification = { requestId: string; requestChecksum: string; runId: string };

/** A returned run is not proof of this submission until all original pins match. */
export async function assertAssistEntryResponse(raw: unknown, original: CreateAssist, scope: string): Promise<AssistView> {
  const request = CreateAssistSchema.parse(original), parsed = AssistViewSchema.safeParse(raw);
  if (!parsed.success || parsed.data.kind !== request.kind || parsed.data.scope !== scope || !parsed.data.request ||
    parsed.data.request.requestId !== request.requestId ||
    await assistIntentHash(assistRequestRecoveryText(parsed.data.request)) !== await assistIntentHash(assistRequestRecoveryText(request)))
    throw new AssistRequestError(502, "原任务与本次请求的类型 范围 编号或摘要不一致 请只读取原回执 不重复付费");
  return parsed.data;
}

/** This proof stays in memory and is derived only from a real, readable request. */
export async function assistEntryVerification(view: AssistView): Promise<AssistEntryVerification | null> {
  const request = view.request;
  if (!request) return null;
  if (request.kind !== view.kind || (request.kind === "knowledge_answer" ? view.scope !== "knowledge:" + request.scopeId :
    request.kind === "order_review" ? view.scope !== "order:" + request.orderLineId : true))
    throw new AssistRequestError(502, "原任务与实际业务对象不一致 未采用另一笔结果");
  return { requestId: request.requestId, requestChecksum: await assistIntentHash(assistRequestRecoveryText(request)), runId: view.id };
}

export function unverifiedAssistEntryIntents(intents: AssistIntent[], kind: AssistKind, verified: AssistEntryVerification[]): AssistIntent[] {
  return intents.filter(intent => intent.kind === kind && !verified.some(proof => intent.runId !== null && proof.runId === intent.runId &&
    proof.requestId === intent.requestId && proof.requestChecksum === intent.requestChecksum));
}

/** A late reply must never recreate an intent removed by logout or explicit reset. */
export function recordAssistEntryRun(intent: AssistIntent, runId: string) {
  const current = readAssistIntents(intent.ownerScope).find(value => value.requestId === intent.requestId);
  if (!current || current.kind !== intent.kind || current.taskScope !== intent.taskScope || current.requestChecksum !== intent.requestChecksum ||
    current.runId !== null && current.runId !== runId)
    throw new AssistRequestError(409, "原请求标识已清除或变化 迟到响应不重建标识 请保留真实任务 ID 核对");
  return recordAssistIntentRun(current, runId);
}
