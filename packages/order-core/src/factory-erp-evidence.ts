import { createHash } from "node:crypto";
import { OriginalOwnerError } from "@yummyai/contracts/common/original-owner-error";
import type { OrderReadVault, OrderSealingVault } from "./order-private-payload.js";
import type { FactoryErpExportRow, FactoryErpParsed } from "@yummyai/contracts/order/factory-erp-import";
import { canonicalJson } from "@yummyai/contracts/common/canonical-json";
import { FactoryErpRawStatusSchema } from "@yummyai/contracts/order/production-delivery";
import type { factoryErpImports, FactoryErpSourceClaim } from "@yummyai/database";
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
export const factoryErpExternalKey = (tenantId: string, factoryId: string, externalId: string) => sha(canonicalJson({ tenantId, factoryId, externalId }));
export const factoryErpRowChecksum = (row: FactoryErpExportRow) => sha(canonicalJson({ ...row, rowNumber: undefined }));
export function factoryErpSourceClaims(tenantId: string, factoryId: string, parsed: FactoryErpParsed): FactoryErpSourceClaim[] {
  return parsed.rows.map(row => ({ rowNumber: row.rowNumber, rowChecksum: factoryErpRowChecksum(row), externalKey: factoryErpExternalKey(tenantId, factoryId, row.externalId),
    quantity: row.itemQuantity, rawStatus: FactoryErpRawStatusSchema.safeParse(row.rawStatus).success ? row.rawStatus as FactoryErpSourceClaim["rawStatus"] : null }));
}
type ProofSource = Pick<typeof factoryErpImports.$inferSelect, "id" | "tenantId" | "factoryId" | "fileChecksum" | "previewChecksum" | "sourceClaims">;
export type FactoryErpDigestProofSource = Omit<ProofSource, "sourceClaims"> & { claimsChecksum: string; sourceProof: string };
const proofValue = (row: ProofSource) => ({ version: 1, tenantId: row.tenantId, importId: row.id, factoryId: row.factoryId, fileChecksum: row.fileChecksum,
  previewChecksum: row.previewChecksum, claimsChecksum: sha(canonicalJson(row.sourceClaims)) });
/** This authenticated envelope contains only hashes, counts and known state
 * claims. It can validate history after private source access expires. */
export function sealFactoryErpProof(vault: OrderSealingVault, row: ProofSource) { return vault.encrypt(canonicalJson(proofValue(row))); }
export function assertFactoryErpProof(vault: OrderReadVault, row: ProofSource & { sourceProof: string }) {
  try {
    vault.withSecret(row.sourceProof, value => { if (canonicalJson(JSON.parse(value)) !== canonicalJson(proofValue(row))) throw new Error("Invalid proof"); });
  } catch { throw new OriginalOwnerError(409, "工厂原件与观察来源校验失败 请保留原记录核对"); }
}

/** The digest and selected claim must come from the same source_claims value in
 * the authorized database query. This authenticates the unchanged full source
 * commitment without loading its complete claim array into the application. */
export function assertFactoryErpProofDigest(vault: OrderReadVault, row: FactoryErpDigestProofSource) {
  try {
    if (![row.id, row.tenantId, row.factoryId].every(value => typeof value === "string" && value.length > 0) ||
      ![row.fileChecksum, row.previewChecksum, row.claimsChecksum].every(value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value))) throw new Error("Invalid proof");
    const expected = { version: 1, tenantId: row.tenantId, importId: row.id, factoryId: row.factoryId, fileChecksum: row.fileChecksum,
      previewChecksum: row.previewChecksum, claimsChecksum: row.claimsChecksum };
    vault.withSecret(row.sourceProof, value => { if (canonicalJson(JSON.parse(value)) !== canonicalJson(expected)) throw new Error("Invalid proof"); });
  } catch { throw new OriginalOwnerError(409, "工厂原件与观察来源校验失败 请保留原记录核对"); }
}
