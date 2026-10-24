import {
  agentResourceDefinitionPayload, agentResourceDataPayload, canonicalAgentResourceInput,
  type AgentResourceDefinition, type AgentResourceKey, type AgentResourceCall,
  type AgentResourceResult, type AgentResourceCandidates, type AgentResourceCandidatesQuery,
} from "@yummyai/contracts/ai/agent-resources";
import { AgentTransportIntegrityError, agentTransportChecksum, agentTransportTextHash } from "@yummyai/contracts/ai/agent-transport";
import { canonicalJson } from "@yummyai/contracts/common/canonical-json";

const invalid = () => new AgentTransportIntegrityError("resource_integrity");
export async function verifyAgentResourceDefinition(value: AgentResourceDefinition, tool: AgentResourceKey) {
  if (value.tool !== tool || await agentTransportChecksum(agentResourceDefinitionPayload(value)) !== value.definitionChecksum) throw invalid();
}
export async function verifyAgentResourceCandidates(value: AgentResourceCandidates, query: AgentResourceCandidatesQuery) {
  if (canonicalJson(value.query) !== canonicalJson(query) || await agentTransportChecksum(query) !== value.inputChecksum) throw invalid();
}
export function assertAgentResourceObject(value: AgentResourceResult, call: AgentResourceCall) {
  if (value.tool !== call.tool || value.definitionChecksum !== call.definitionChecksum || canonicalJson(value.input) !== canonicalJson(call.input)) throw invalid();
  let primary: { id: string; versionId: string | null; revision: number | null };
  if (value.tool === "research.evidence" && call.tool === value.tool) {
    const source = value.data.source, snapshot = value.data.snapshot;
    if (source.researchItemId !== call.input.researchItemId || source.snapshotId !== call.input.snapshotId || source.studyRevisionId !== call.input.studyRevisionId ||
      snapshot.domain !== "research" || source.platform !== snapshot.platform) throw invalid();
    primary = { id: source.researchItemId, versionId: source.snapshotId, revision: null };
  } else if (value.tool === "catalog.sku" && call.tool === value.tool) {
    if (value.data.skuId !== call.input.skuId || value.data.recipe && (value.data.recipe.skuId !== call.input.skuId || call.input.recipeId !== null && value.data.recipe.id !== call.input.recipeId) ||
      call.input.recipeId !== null && value.data.recipe === null || !value.data.packageRead && value.data.packages.length > 0) throw invalid();
    primary = { id: value.data.skuId, versionId: null, revision: null };
  } else if (value.tool === "listing.version" && call.tool === value.tool) {
    const { listing, version } = value.data;
    if (listing.id !== call.input.listingId || version.id !== call.input.versionId || version.listingId !== listing.id ||
      version.content.platform !== listing.platform || version.content.locale !== listing.locale) throw invalid();
    primary = { id: listing.id, versionId: version.id, revision: version.versionNumber };
  } else if (value.tool === "orders.order" && call.tool === value.tool) {
    if (value.data.id !== call.input.orderId || value.data.latestEventSequence !== call.input.expectedSequence || value.data.lineCount !== value.data.lines.length) throw invalid();
    primary = { id: value.data.id, versionId: null, revision: value.data.latestEventSequence };
  } else if (value.tool === "finance.profit_run" && call.tool === value.tool) {
    if (value.data.id !== call.input.runId) throw invalid();
    primary = { id: value.data.id, versionId: null, revision: null };
  } else if (value.tool === "advertising.analysis" && call.tool === value.tool) {
    if (value.data.id !== call.input.analysisId || value.data.accountId !== call.input.accountId) throw invalid();
    primary = { id: value.data.id, versionId: null, revision: null };
  } else throw invalid();
  if (!value.sources.some(source => source.id === primary.id && source.versionId === primary.versionId && source.revision === primary.revision)) throw invalid();
}
export async function verifyAgentResourceResult(value: AgentResourceResult, call: AgentResourceCall) {
  assertAgentResourceObject(value, call);
  if (await agentTransportTextHash(canonicalAgentResourceInput(call)) !== value.inputChecksum ||
    await agentTransportChecksum(agentResourceDataPayload(value)) !== value.dataChecksum) throw invalid();
}
