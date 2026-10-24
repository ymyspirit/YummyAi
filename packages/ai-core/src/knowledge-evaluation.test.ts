import { describe, expect, it } from "vitest";
import { KnowledgeEvaluationCaseSchema } from "@yummyai/contracts/knowledge/evaluation-case";
import { KnowledgeEvaluationProtocolSchema, KnowledgeEvaluationAssessmentSchema, KNOWLEDGE_EVALUATION_ASSERTIONS } from "@yummyai/contracts/knowledge/evaluation-protocol";
import { AssistResultSchema, CreateAssistSchema } from "@yummyai/contracts/ai/assist";
import { assistFingerprint, type AssistContext } from "./assist.js";
import { SecretVault } from "./secrets.js";
import { authenticateKnowledgeEvaluation, knowledgeEvaluationAssessmentChecksum, knowledgeEvaluationBasis, knowledgeEvaluationChecksum, knowledgeEvaluationRequestChecksum, scoreKnowledgeEvaluation, sealKnowledgeEvaluationAssessment, sealKnowledgeEvaluationProtocol } from "./knowledge-evaluation.js";

const id = (n: number) => `019f0000-0000-7000-8000-${String(n).padStart(12, "0")}`;
const snapshot = () => KnowledgeEvaluationCaseSchema.parse({ label: "Synthetic evaluation", search: { query: "Only approved materials", topic: "all", platform: "all", market: "ALL", spuIds: [] }, expectedFacts: ["original answer"], forbiddenClaims: ["unsupported guarantee"], requiredEntryIds: [], expectRefusal: false });
const input = (): AssistContext => ({ request: CreateAssistSchema.parse({ kind: "knowledge_answer", purpose: "evaluation", scopeId: id(1), modelId: id(2), requestId: id(3), search: snapshot().search, evidenceStoreId: null, previousRunId: null }), accessPolicy: { version: "v1", dataScope: "self", requiredPermissions: ["workflow:read", "workflow:manage", "workflow:run"] },
  data: { retrieval: { retrievedAt: "2026-10-21T00:00:00.000Z", references: ["original-source"] } }, sources: [], checks: [], diagnostics: [], images: [], allowedArtworkIds: [], allowedSpecificationIds: [], allowMatches: false, knowledge: [] });
const result = () => AssistResultSchema.parse({ summary: "Original answer", findings: [], directions: [], matches: [], artworkChecks: [], missingInformation: [], templateSlots: [], actions: [], listingCopy: null, replyDraft: null });
function receipt() {
  const vault = new SecretVault(Buffer.alloc(32, 49)), prepared = input(), fields = snapshot();
  const run = { id: id(4), tenantId: id(5), createdBy: id(6), caseId: id(1), assistRunId: id(7), requestId: id(3), caseSnapshot: fields };
  const native = { id: id(7), tenantId: id(5), ownerId: id(6), requestId: id(3), kind: "knowledge_answer", scope: `knowledge:${id(1)}`, modelSnapshot: { id: id(2) }, inputFingerprint: assistFingerprint(prepared), promptVersion: "synthetic-v1" };
  const protocolView = KnowledgeEvaluationProtocolSchema.parse({ version: "knowledge-evaluation-v1", runId: run.id, caseRevision: 1, caseChecksum: knowledgeEvaluationChecksum(fields), requestChecksum: knowledgeEvaluationRequestChecksum(run.caseId, { modelId: id(2), requestId: id(3) }), basisFingerprint: knowledgeEvaluationBasis(fields, prepared, native.promptVersion), inputFingerprint: native.inputFingerprint, modelId: id(2), dataScope: "self", promptVersion: native.promptVersion, assertionVersion: KNOWLEDGE_EVALUATION_ASSERTIONS, createdAt: "2026-10-21T00:00:00.000Z" });
  const protocol = { tenantId: run.tenantId, createdBy: run.createdBy, proof: sealKnowledgeEvaluationProtocol(vault, { tenantId: run.tenantId, createdBy: run.createdBy, assistRunId: native.id, protocol: protocolView }) };
  return { vault, prepared, value: { run, native, protocolView, protocol, assessmentView: null, assessment: null } };
}
describe("native knowledge evaluation evidence", () => {
  it("allows model/transport/time variation but pins the actual retrieved evidence and prompt", () => {
    const original = input(), changed = structuredClone(original);
    changed.request.modelId = id(8); changed.request.requestId = id(9); changed.data.retrieval = { retrievedAt: "2026-10-22T00:00:00.000Z", references: ["original-source"] };
    expect(knowledgeEvaluationBasis(snapshot(), changed, "v1")).toBe(knowledgeEvaluationBasis(snapshot(), original, "v1"));
    changed.data.retrieval = { references: ["new-source"] };
    expect(knowledgeEvaluationBasis(snapshot(), changed, "v1")).not.toBe(knowledgeEvaluationBasis(snapshot(), original, "v1"));
    expect(knowledgeEvaluationBasis(snapshot(), original, "v2")).not.toBe(knowledgeEvaluationBasis(snapshot(), original, "v1"));
  });
  it("authenticates the actual case, actor, model and access scope together", () => {
    const { vault, prepared, value } = receipt();
    expect(() => authenticateKnowledgeEvaluation(vault, value, prepared)).not.toThrow();
    const changed = structuredClone(value); changed.protocolView.dataScope = "tenant";
    expect(() => authenticateKnowledgeEvaluation(vault, changed)).toThrow("knowledge_evaluation_proof_invalid");
    const actor = structuredClone(value); actor.run.createdBy = id(11);
    expect(() => authenticateKnowledgeEvaluation(vault, actor)).toThrow("knowledge_evaluation_proof_invalid");
  });
  it("refuses substituted ciphertext and valid envelopes sealed under another key", () => {
    const { vault, value } = receipt();
    value.protocol.proof = new SecretVault(Buffer.alloc(32, 50)).encrypt("{}");
    expect(() => authenticateKnowledgeEvaluation(vault, value)).toThrow("knowledge_evaluation_proof_invalid");
  });
  it("validates original inputs and excludes post-creation source substitution", () => {
    const { vault, value, prepared } = receipt(); prepared.data.retrieval = { references: ["substitution"] };
    expect(() => authenticateKnowledgeEvaluation(vault, value, prepared)).toThrow("knowledge_evaluation_proof_invalid");
  });
  it("seals completed assertions separately from mutable read availability", () => {
    const { vault, value } = receipt(), output = result();
    const assessmentView = KnowledgeEvaluationAssessmentSchema.parse({ id: id(12), runId: value.run.id, basisFingerprint: value.protocolView.basisFingerprint, outputChecksum: knowledgeEvaluationChecksum(output), assertionVersion: KNOWLEDGE_EVALUATION_ASSERTIONS, ...scoreKnowledgeEvaluation(snapshot(), { status: "completed", result: output, knowledge: [], error: null }), createdAt: "2026-10-21T00:01:00.000Z" });
    const resultChecksum = knowledgeEvaluationAssessmentChecksum(assessmentView);
    const assessment = { tenantId: value.run.tenantId, createdBy: value.run.createdBy, resultChecksum, proof: sealKnowledgeEvaluationAssessment(vault, { tenantId: value.run.tenantId, createdBy: value.run.createdBy, resultChecksum, assessment: assessmentView }) };
    expect(() => authenticateKnowledgeEvaluation(vault, { ...value, assessmentView, assessment })).not.toThrow();
    assessmentView.checks[3]!.status = "fail";
    expect(() => authenticateKnowledgeEvaluation(vault, { ...value, assessmentView, assessment })).toThrow("knowledge_evaluation_proof_invalid");
  });
  it("never seals pending checks and keeps phrase matches distinct from human fact review", () => {
    const checks = scoreKnowledgeEvaluation(snapshot(), { status: "queued", result: null, knowledge: [], error: null });
    expect(checks.checks.every(check => check.status === "pending")).toBe(true);
    const output = result(); output.summary += " unsupported guarantee";
    const completed = scoreKnowledgeEvaluation(snapshot(), { status: "completed", result: output, knowledge: [], error: null });
    expect(completed.checks.find(check => check.key === "forbidden")?.status).toBe("fail");
    expect(completed.checks.find(check => check.key === "expected_facts")?.detail).toContain("不等于已经人工核验事实性");
  });
});
