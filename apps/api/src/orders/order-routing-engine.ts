import { createHash } from "node:crypto";

import {
  CreateRoutingPolicyInputSchema,
  SupplierRoutingCandidateSchema,
  type CreateRoutingPolicyInput,
  type SupplierRoutingCandidate,
  type SupplierStatus,
} from "@yummyai/contracts";

type ExclusionCode = SupplierRoutingCandidate["exclusionCodes"][number];

export interface RoutingSourceCandidate {
  supplier: { id: string; status: SupplierStatus; priority: number };
  capability: {
    id: string; supportedSkuIds: string[]; processCodes: string[]; serviceCountryCodes: string[];
    blockedRegionCodes: string[]; qualityScoreBps: number;
  };
  quote: { id: string; skuId: string; unitCostMinor: number; currency: string; minimumOrderQuantity: number; leadTimeDays: number; validFrom: string; validUntil: string };
  capacity: { id: string; startsAt: string; endsAt: string; availableUnits: number; reservedUnits: number };
}

export interface RoutingEngineInput {
  skuId: string;
  quantity: number;
  currency: string;
  processCodes: string[];
  destinationCountryCode: string;
  destinationRegionCode: string | null;
  evaluatedAt: string;
  policy: CreateRoutingPolicyInput & { id: string; versionNumber: number };
  candidates: RoutingSourceCandidate[];
}

export interface RoutingEngineResult {
  inputChecksum: string;
  candidates: SupplierRoutingCandidate[];
  selectedSupplierId: string | null;
  requiresApproval: boolean;
  approvalReasons: Array<"cost_threshold" | "risk_threshold" | "no_eligible_supplier">;
}

export function evaluateSupplierRouting(input: RoutingEngineInput): RoutingEngineResult {
  const rawPolicy = {
    name: input.policy.name, weights: input.policy.weights, minimumQualityBps: input.policy.minimumQualityBps,
    maximumLeadTimeDays: input.policy.maximumLeadTimeDays, maximumUnitCostMinor: input.policy.maximumUnitCostMinor,
    manualApprovalCostMinor: input.policy.manualApprovalCostMinor, manualApprovalRiskBps: input.policy.manualApprovalRiskBps,
    tieBreaker: input.policy.tieBreaker,
  };
  const policy = CreateRoutingPolicyInputSchema.parse(rawPolicy);
  if (!Number.isInteger(input.quantity) || input.quantity <= 0) throw new Error("Routing quantity must be a positive integer");
  const evaluatedAt = new Date(input.evaluatedAt);
  if (Number.isNaN(evaluatedAt.getTime())) throw new Error("Routing evaluation time is invalid");
  const candidates = input.candidates.map((source) => evaluateCandidate(input, policy, source));
  candidates.sort(compareCandidates);
  const selected = candidates.find((candidate) => candidate.eligible) ?? null;
  const approvalReasons: RoutingEngineResult["approvalReasons"] = [];
  if (!selected) approvalReasons.push("no_eligible_supplier");
  if (selected && selected.unitCostMinor >= policy.manualApprovalCostMinor) approvalReasons.push("cost_threshold");
  if (selected && 10_000 - selected.qualityScoreBps >= policy.manualApprovalRiskBps) approvalReasons.push("risk_threshold");
  return {
    inputChecksum: sha256(stableStringify(canonicalInput(input, policy))),
    candidates,
    selectedSupplierId: selected?.supplierId ?? null,
    requiresApproval: approvalReasons.length > 0,
    approvalReasons,
  };
}

function evaluateCandidate(input: RoutingEngineInput, policy: CreateRoutingPolicyInput, source: RoutingSourceCandidate): SupplierRoutingCandidate {
  const exclusions: ExclusionCode[] = [];
  const availableUnits = Math.max(0, source.capacity.availableUnits - source.capacity.reservedUnits);
  const capabilityEligible = source.capability.supportedSkuIds.includes(input.skuId);
  const processEligible = input.processCodes.every((process) => source.capability.processCodes.includes(process));
  const regionBlocked = input.destinationRegionCode ? source.capability.blockedRegionCodes.includes(input.destinationRegionCode) : false;
  const regionEligible = source.capability.serviceCountryCodes.includes(input.destinationCountryCode) && !regionBlocked;
  const quoteValid = source.quote.skuId === input.skuId && source.quote.validFrom <= input.evaluatedAt && source.quote.validUntil > input.evaluatedAt;
  const capacityValid = source.capacity.startsAt <= input.evaluatedAt && source.capacity.endsAt > input.evaluatedAt;
  if (source.supplier.status !== "active") exclusions.push("supplier_inactive");
  if (!capabilityEligible) exclusions.push("sku_unsupported");
  if (!processEligible) exclusions.push("process_unsupported");
  if (regionBlocked) exclusions.push("region_blocked"); else if (!regionEligible) exclusions.push("region_unsupported");
  if (!quoteValid) exclusions.push("quote_invalid");
  if (source.quote.currency !== input.currency) exclusions.push("currency_mismatch");
  if (input.quantity < source.quote.minimumOrderQuantity) exclusions.push("moq_unmet");
  if (source.quote.unitCostMinor > policy.maximumUnitCostMinor) exclusions.push("cost_exceeded");
  if (source.quote.leadTimeDays > policy.maximumLeadTimeDays) exclusions.push("lead_time_exceeded");
  if (source.capability.qualityScoreBps < policy.minimumQualityBps) exclusions.push("quality_below_minimum");
  if (!capacityValid || availableUnits < input.quantity) exclusions.push("capacity_insufficient");
  const scores = {
    capability: capabilityEligible && processEligible ? 10_000 : 0,
    region: regionEligible ? 10_000 : 0,
    cost: inverseScore(source.quote.unitCostMinor, policy.maximumUnitCostMinor),
    leadTime: inverseScore(source.quote.leadTimeDays, policy.maximumLeadTimeDays),
    capacity: Math.min(10_000, Math.floor(availableUnits * 10_000 / Math.max(1, availableUnits + input.quantity))),
    quality: source.capability.qualityScoreBps,
    priority: Math.max(0, Math.min(10_000, (6 - source.supplier.priority) * 2_000)),
  };
  const total = Math.floor((scores.capability * policy.weights.capability + scores.region * policy.weights.region +
    scores.cost * policy.weights.cost + scores.leadTime * policy.weights.leadTime + scores.capacity * policy.weights.capacity +
    scores.quality * policy.weights.quality + scores.priority * policy.weights.priority) / 10_000);
  return SupplierRoutingCandidateSchema.parse({
    supplierId: source.supplier.id, quoteId: source.quote.id, capabilitySnapshotId: source.capability.id,
    capacityWindowId: source.capacity.id, eligible: exclusions.length === 0, exclusionCodes: [...new Set(exclusions)],
    scores: { ...scores, total }, unitCostMinor: source.quote.unitCostMinor, leadTimeDays: source.quote.leadTimeDays,
    availableUnits, qualityScoreBps: source.capability.qualityScoreBps,
  });
}

function compareCandidates(left: SupplierRoutingCandidate, right: SupplierRoutingCandidate): number {
  if (left.eligible !== right.eligible) return left.eligible ? -1 : 1;
  return right.scores.total - left.scores.total || left.unitCostMinor - right.unitCostMinor ||
    left.leadTimeDays - right.leadTimeDays || left.supplierId.localeCompare(right.supplierId);
}

function inverseScore(value: number, maximum: number): number {
  if (maximum === 0) return value === 0 ? 10_000 : 0;
  return Math.max(0, 10_000 - Math.floor(value * 10_000 / maximum));
}

function canonicalInput(input: RoutingEngineInput, policy: CreateRoutingPolicyInput) {
  return {
    skuId: input.skuId, quantity: input.quantity, currency: input.currency, processCodes: [...input.processCodes].sort(),
    destinationCountryCode: input.destinationCountryCode, destinationRegionCode: input.destinationRegionCode,
    evaluatedAt: input.evaluatedAt, policy: { id: input.policy.id, versionNumber: input.policy.versionNumber, ...policy },
    candidates: [...input.candidates].sort((left, right) => left.supplier.id.localeCompare(right.supplier.id)),
  };
}

function sha256(value: string) { return createHash("sha256").update(value).digest("hex"); }
function stableStringify(value: unknown): string { if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`; if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`).join(",")}}`; return JSON.stringify(value) ?? "null"; }
