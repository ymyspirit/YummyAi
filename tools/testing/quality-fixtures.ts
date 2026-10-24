import type { RecordQualityInspectionInput, TenantContext } from "../../packages/contracts/src/index";
import type { QualityAssessment, QualityStandardBasis } from "../../packages/contracts/src/order/quality-assessment";

/** Explicit disposable fixture attestations, never a default for real inspections. */
export function syntheticQualityAssessment(standard: QualityStandardBasis, scoreBps: number, passed = true): QualityAssessment {
  return { formatVersion: 2, criterionResults: standard.criteria.map(criterion => ({
    code: criterion.code, scoreBps, passed, evidenceAssetIds: [],
  })) };
}
type Reader = {
  get(context: TenantContext, id: string): Promise<{ productionOrder: { projectionVersion: number } }>;
  qualityStandards(context: TenantContext): Promise<Array<QualityStandardBasis & { id: string }>>;
};
export async function syntheticQualityInspection(
  reader: Reader, context: TenantContext, id: string, input: RecordQualityInspectionInput,
): Promise<RecordQualityInspectionInput> {
  const [record, standards] = await Promise.all([reader.get(context, id), reader.qualityStandards(context)]);
  const standard = standards.find(row => row.id === input.qualityStandardVersionId);
  if (!standard) throw new Error("Synthetic inspection standard missing");
  return { ...input, expectedProductionProjectionVersion: record.productionOrder.projectionVersion,
    assessment: syntheticQualityAssessment(standard, input.scoreBps, input.result === "passed") };
}
export async function syntheticWholeQualityInspection<T extends { qualityStandardVersionId: string; scoreBps: number }>(
  reader: Pick<Reader, "qualityStandards">, context: TenantContext, input: T,
) {
  const standard = (await reader.qualityStandards(context)).find(row => row.id === input.qualityStandardVersionId);
  if (!standard) throw new Error("Synthetic whole inspection standard missing");
  return { ...input, assessment: syntheticQualityAssessment(standard, input.scoreBps) };
}
