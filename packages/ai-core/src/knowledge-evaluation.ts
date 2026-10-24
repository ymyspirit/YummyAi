import { createHash } from "node:crypto";
import { canonicalJson } from "@yummyai/contracts/common/canonical-json";
import type { KnowledgeEvaluationCase } from "@yummyai/contracts/knowledge/evaluation-case";
import { KNOWLEDGE_EVALUATION_ASSERTIONS, type KnowledgeEvaluationAssessment, type KnowledgeEvaluationCheck, type KnowledgeEvaluationProtocol } from "@yummyai/contracts/knowledge/evaluation-protocol";
import type { AssistView } from "@yummyai/contracts/ai/assist";
import type { AssistContext } from "./assist.js";
import type { SecretVault } from "./secrets.js";
import { assistTaskFingerprint } from "./assist-task-fingerprint.js";
import { assistFingerprint } from "./assist.js";
export const knowledgeEvaluationChecksum = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");
export const knowledgeEvaluationRequestChecksum = (caseId: string, input: { modelId: string; requestId: string }) =>
  knowledgeEvaluationChecksum({ version: 1, operation: "knowledge-evaluation-start", caseId, input });
export const knowledgeEvaluationBasis = (snapshot: KnowledgeEvaluationCase, input: AssistContext, promptVersion: string) =>
  knowledgeEvaluationChecksum({ caseChecksum: knowledgeEvaluationChecksum(snapshot), taskFingerprint: assistTaskFingerprint(input),
    executionContract: input.executionContract ?? null, promptVersion, assertionVersion: KNOWLEDGE_EVALUATION_ASSERTIONS });
export const knowledgeEvaluationAssessmentChecksum = (value: Pick<KnowledgeEvaluationAssessment, "basisFingerprint" | "outputChecksum" | "assertionVersion" | "retrievalRecall" | "citedRecall" | "checks">) =>
  knowledgeEvaluationChecksum({ basisFingerprint: value.basisFingerprint, outputChecksum: value.outputChecksum, assertionVersion: value.assertionVersion,
    retrievalRecall: value.retrievalRecall, citedRecall: value.citedRecall, checks: value.checks });
type ProtocolProof = { tenantId: string; createdBy: string; assistRunId: string; protocol: KnowledgeEvaluationProtocol };
type AssessmentProof = { tenantId: string; createdBy: string; resultChecksum: string; assessment: KnowledgeEvaluationAssessment };
export class KnowledgeEvaluationProofError extends Error { constructor() { super("knowledge_evaluation_proof_invalid"); } }
const proofBody = (kind: "protocol" | "assessment", value: ProtocolProof | AssessmentProof) => canonicalJson({ version: 1, domain: "knowledge-evaluation-" + kind, ...value });
function assertProof(vault: SecretVault, kind: "protocol" | "assessment", value: ProtocolProof | AssessmentProof, proof: string) {
  try { vault.withSecret(proof, text => { if (canonicalJson(JSON.parse(text)) !== proofBody(kind, value)) throw new KnowledgeEvaluationProofError(); }); }
  catch { throw new KnowledgeEvaluationProofError(); }
}
export const sealKnowledgeEvaluationProtocol = (vault: SecretVault, value: ProtocolProof) => vault.encrypt(proofBody("protocol", value));
export const assertKnowledgeEvaluationProtocol = (vault: SecretVault, value: ProtocolProof, proof: string) => assertProof(vault, "protocol", value, proof);
export const sealKnowledgeEvaluationAssessment = (vault: SecretVault, value: AssessmentProof) => vault.encrypt(proofBody("assessment", value));
export const assertKnowledgeEvaluationAssessment = (vault: SecretVault, value: AssessmentProof, proof: string) => assertProof(vault, "assessment", value, proof);

type EvaluationReceipt = {
  run: { id: string; tenantId: string; createdBy: string; caseId: string; assistRunId: string; requestId: string; caseSnapshot: KnowledgeEvaluationCase };
  native: { id: string; tenantId: string; ownerId: string; requestId: string; kind: string; scope: string; inputFingerprint: string; promptVersion: string; modelSnapshot: { id: string } };
  protocol: { proof: string; tenantId: string; createdBy: string } | null;
  protocolView: KnowledgeEvaluationProtocol | null;
  assessment: { proof: string; tenantId: string; createdBy: string; resultChecksum: string } | null;
  assessmentView: KnowledgeEvaluationAssessment | null;
};
/** Authenticate immutable headers as well as the encrypted proof; SQL cannot decrypt it. */
export function authenticateKnowledgeEvaluation(vault: SecretVault, receipt: EvaluationReceipt, input?: AssistContext) {
  const { run, native, protocol, protocolView: pinned, assessment, assessmentView: score } = receipt;
  if (native.tenantId !== run.tenantId || native.ownerId !== run.createdBy || native.id !== run.assistRunId ||
      native.requestId !== run.requestId || native.kind !== "knowledge_answer" || native.scope !== `knowledge:${run.caseId}`)
    throw new KnowledgeEvaluationProofError();
  if (!pinned || !protocol) {
    if (score || assessment) throw new KnowledgeEvaluationProofError();
    return;
  }
  if (protocol.tenantId !== run.tenantId || protocol.createdBy !== run.createdBy || pinned.runId !== run.id ||
      pinned.modelId !== native.modelSnapshot.id || pinned.inputFingerprint !== native.inputFingerprint ||
      pinned.promptVersion !== native.promptVersion || pinned.caseChecksum !== knowledgeEvaluationChecksum(run.caseSnapshot) ||
      pinned.requestChecksum !== knowledgeEvaluationRequestChecksum(run.caseId, { modelId: pinned.modelId, requestId: run.requestId }))
    throw new KnowledgeEvaluationProofError();
  assertKnowledgeEvaluationProtocol(vault, { tenantId: run.tenantId, createdBy: run.createdBy, assistRunId: run.assistRunId, protocol: pinned }, protocol.proof);
  if (input && (input.accessPolicy?.dataScope !== pinned.dataScope || assistFingerprint(input) !== pinned.inputFingerprint || knowledgeEvaluationBasis(run.caseSnapshot, input, pinned.promptVersion) !== pinned.basisFingerprint ||
      input.request.kind !== "knowledge_answer" || input.request.purpose !== "evaluation" || input.request.scopeId !== run.caseId ||
      input.request.modelId !== pinned.modelId || input.request.requestId !== run.requestId ||
      knowledgeEvaluationChecksum(input.request.search) !== knowledgeEvaluationChecksum(run.caseSnapshot.search))) throw new KnowledgeEvaluationProofError();
  if (score && assessment) {
    if (assessment.tenantId !== run.tenantId || assessment.createdBy !== run.createdBy || score.runId !== run.id ||
        score.basisFingerprint !== pinned.basisFingerprint || score.assertionVersion !== pinned.assertionVersion ||
        assessment.resultChecksum !== knowledgeEvaluationAssessmentChecksum(score)) throw new KnowledgeEvaluationProofError();
    assertKnowledgeEvaluationAssessment(vault, { tenantId: run.tenantId, createdBy: run.createdBy, resultChecksum: assessment.resultChecksum, assessment: score }, assessment.proof);
  } else if (score || assessment) throw new KnowledgeEvaluationProofError();
}

/** Fixed v1 assertions. Phrase and source-ID matching do not prove factual truth. */
export function scoreKnowledgeEvaluation(snapshot: KnowledgeEvaluationCase, answer: Pick<AssistView, "status" | "knowledge" | "result" | "error">) {
  const sourceMap = new Map(answer.knowledge.map(row => [row.sourceId, row.entryId]));
  const retrieved = new Set(answer.knowledge.map(row => row.entryId));
  const cited = new Set(answer.result?.findings.flatMap(finding => finding.evidence.map(evidence => sourceMap.get(evidence.sourceId)).filter((id): id is string => !!id)) ?? []);
  const allText = (answer.result?.summary ?? "") + " " + (answer.result?.findings.map(finding => finding.title + " " + finding.detail).join(" ") ?? "");
  const normalized = allText.normalize("NFKC").toLowerCase();
  const missing = snapshot.expectedFacts.filter(text => !normalized.includes(text.normalize("NFKC").toLowerCase()));
  const prohibited = snapshot.forbiddenClaims.filter(text => normalized.includes(text.normalize("NFKC").toLowerCase()));
  const required = snapshot.requiredEntryIds;
  const retrievalRecall = required.length ? required.filter(id => retrieved.has(id)).length / required.length : null;
  const citedRecall = required.length ? required.filter(id => cited.has(id)).length / required.length : null;
  const complete = answer.status === "completed" && !!answer.result;
  const status = (pass: boolean): KnowledgeEvaluationCheck["status"] => complete ? pass ? "pass" : "fail" : "pending";
  const checks: KnowledgeEvaluationCheck[] = [
    { key: "answer_completed", label: "真实回答完成", status: answer.status === "failed" || answer.status === "cancelled" ? "fail" : complete ? "pass" : "pending", detail: answer.error ?? answer.status },
    { key: "retrieval", label: "必需来源召回", status: status(retrievalRecall === null || retrievalRecall === 1), detail: retrievalRecall === null ? "未定义必需来源" : String(retrievalRecall) },
    { key: "citation", label: "答案引用必需来源", status: status(citedRecall === null || citedRecall === 1), detail: citedRecall === null ? "未定义必需来源" : String(citedRecall) },
    { key: "expected_facts", label: "答案要点断言", status: status(!missing.length), detail: missing.length ? "缺少：" + missing.join("；") : "要点断言匹配；不等于已经人工核验事实性" },
    { key: "forbidden", label: "禁止推断断言", status: status(!prohibited.length), detail: prohibited.length ? "命中：" + prohibited.join("；") : "未命中禁止表述" },
    { key: "refusal", label: "无依据时的回应", status: status(!snapshot.expectRefusal || (!!answer.result?.missingInformation.length && !answer.result.findings.some(finding => finding.kind === "fact"))), detail: snapshot.expectRefusal ? "本题要求拒答并说明资料缺口" : "本题不要求拒答" },
    { key: "evidence", label: "事实引用有效", status: status(!answer.result?.findings.some(finding => finding.kind === "fact" && (!finding.evidence.length || finding.evidence.some(evidence => !sourceMap.has(evidence.sourceId))))), detail: "仅核对固定引用 ID；含义、条件与事实性需要人工核验" },
  ];
  return { retrievalRecall, citedRecall, checks };
}
