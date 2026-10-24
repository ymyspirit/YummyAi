import { factoryErpExternalKey as sharedFactoryErpExternalKey, factoryErpRowChecksum as sharedFactoryErpRowChecksum } from "@yummyai/order-core";
import { factoryErpSourceClaims as sharedfactoryErpSourceClaims, sealFactoryErpProof as sharedsealFactoryErpProof, assertFactoryErpProof as sharedassertFactoryErpProof, assertFactoryErpProofDigest as sharedassertFactoryErpProofDigest } from "@yummyai/order-core";
import { rethrowOriginalOwnerError } from "../shared/original-owner-error.js";

import type { SecretVault } from "@yummyai/ai-core";
import type { FactoryErpExportRow, FactoryErpParsed } from "@yummyai/contracts/order/factory-erp-import";

import type { factoryErpImports, FactoryErpSourceClaim } from "@yummyai/database";

export const factoryErpExternalKey = (tenantId: string, factoryId: string, externalId: string) => sharedFactoryErpExternalKey(tenantId, factoryId, externalId);
export const factoryErpRowChecksum = (row: FactoryErpExportRow) => sharedFactoryErpRowChecksum(row);
export function factoryErpSourceClaims(tenantId: string, factoryId: string, parsed: FactoryErpParsed): FactoryErpSourceClaim[] { try { return sharedfactoryErpSourceClaims(tenantId, factoryId, parsed); } catch(error) { rethrowOriginalOwnerError(error); } }
type ProofSource = Pick<typeof factoryErpImports.$inferSelect, "id" | "tenantId" | "factoryId" | "fileChecksum" | "previewChecksum" | "sourceClaims">;
export type FactoryErpDigestProofSource = Omit<ProofSource, "sourceClaims"> & { claimsChecksum: string; sourceProof: string };

/** This authenticated envelope contains only hashes, counts and known state
 * claims. It can validate history after private source access expires. */
export function sealFactoryErpProof(vault: SecretVault, row: ProofSource) { try { return sharedsealFactoryErpProof(vault, row); } catch(error) { rethrowOriginalOwnerError(error); } }
export function assertFactoryErpProof(vault: SecretVault, row: ProofSource & { sourceProof: string }) { try { return sharedassertFactoryErpProof(vault, row); } catch(error) { rethrowOriginalOwnerError(error); } }

/** The digest and selected claim must come from the same source_claims value in
 * the authorized database query. This authenticates the unchanged full source
 * commitment without loading its complete claim array into the application. */
export function assertFactoryErpProofDigest(vault: SecretVault, row: FactoryErpDigestProofSource) { try { return sharedassertFactoryErpProofDigest(vault, row); } catch(error) { rethrowOriginalOwnerError(error); } }
