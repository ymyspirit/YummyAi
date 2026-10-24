import { createHash, randomBytes } from "node:crypto";
import { ConflictException } from "@nestjs/common";
import { SecretVault } from "@yummyai/ai-core";
import { createEntityId } from "@yummyai/contracts";
import { canonicalJson } from "@yummyai/contracts/common/canonical-json";
import { describe, expect, it } from "vitest";
import { assertFactoryErpProof, assertFactoryErpProofDigest, sealFactoryErpProof, type FactoryErpDigestProofSource } from "./factory-erp-evidence.js";
describe("authenticated nonprivate factory source commitments", () => {
  it("binds the original import, tenant, factory, byte and preview hashes plus each exact status claim", () => {
    const vault = new SecretVault(randomBytes(32)), row = { id: createEntityId(), tenantId: createEntityId(), factoryId: createEntityId(), fileChecksum: "a".repeat(64), previewChecksum: "b".repeat(64),
      sourceClaims: [{ rowNumber: 2, rowChecksum: "c".repeat(64), externalKey: "d".repeat(64), quantity: 4, rawStatus: "已审核" as const }] };
    const source = { ...row, sourceProof: sealFactoryErpProof(vault, row) };
    expect(() => assertFactoryErpProof(vault, source)).not.toThrow();
    for (const field of ["id", "tenantId", "factoryId", "fileChecksum", "previewChecksum"] as const)
      expect(() => assertFactoryErpProof(vault, { ...source, [field]: field.endsWith("Checksum") ? "e".repeat(64) : createEntityId() })).toThrow();
    expect(() => assertFactoryErpProof(vault, { ...source, sourceClaims: [{ ...row.sourceClaims[0]!, rawStatus: "已出库" }] })).toThrow();
    expect(() => assertFactoryErpProof(new SecretVault(randomBytes(32)), source)).toThrow();
    const body = vault.withSecret(source.sourceProof, value => JSON.parse(value));
    expect(Object.keys(body).sort()).toEqual(["claimsChecksum", "factoryId", "fileChecksum", "importId", "previewChecksum", "tenantId", "version"]);
    expect(body).not.toHaveProperty("rawCells"); expect(body).not.toHaveProperty("externalId"); expect(body).not.toHaveProperty("trackingReference");
  });
});

type Source = Parameters<typeof sealFactoryErpProof>[1];
const digest = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");
function source(): Source {
  return { id: createEntityId(), tenantId: createEntityId(), factoryId: createEntityId(), fileChecksum: "a".repeat(64), previewChecksum: "b".repeat(64),
    sourceClaims: [
      { rowNumber: 2, rowChecksum: "c".repeat(64), externalKey: "d".repeat(64), quantity: 4, rawStatus: "已作废" },
      { rowNumber: 3, rowChecksum: "e".repeat(64), externalKey: "f".repeat(64), quantity: 6, rawStatus: "已审核" },
    ] };
}
function digestProof(vault: SecretVault, row: Source): FactoryErpDigestProofSource {
  const { sourceClaims, ...identity } = row;
  return { ...identity, claimsChecksum: digest(sourceClaims), sourceProof: sealFactoryErpProof(vault, row) };
}
function rejected(vault: SecretVault, row: FactoryErpDigestProofSource) {
  let failure: unknown;
  try { assertFactoryErpProofDigest(vault, row); } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(ConflictException);
  expect((failure as ConflictException).message).toBe("工厂原件与观察来源校验失败 请保留原记录核对");
  expect((failure as ConflictException).getStatus()).toBe(409);
}

describe("bounded digest authentication of the original factory source envelope", () => {
  it("authenticates all 5000 exact Chinese and null claims through the unchanged original envelope", () => {
    const vault = new SecretVault(randomBytes(32)), row = source();
    row.sourceClaims = Array.from({ length: 5000 }, (_, index): Source["sourceClaims"][number] => ({
      rowNumber: index + 2, rowChecksum: createHash("sha256").update(`synthetic-row-${index}`).digest("hex"),
      externalKey: createHash("sha256").update(`synthetic-key-${index}`).digest("hex"), quantity: index === 4999 ? 100_000 : index + 1,
      rawStatus: index % 4 === 0 ? null : index % 4 === 1 ? "已审核" : index % 4 === 2 ? "已出库" : "已作废",
    }));
    const proof = digestProof(vault, row);
    expect(() => assertFactoryErpProofDigest(vault, proof)).not.toThrow();
    expect(() => assertFactoryErpProof(vault, { ...row, sourceProof: proof.sourceProof })).not.toThrow();
    expect(proof).not.toHaveProperty("sourceClaims");
    const original = vault.withSecret(proof.sourceProof, value => JSON.parse(value));
    expect(original).toEqual({ version: 1, tenantId: row.tenantId, importId: row.id, factoryId: row.factoryId,
      fileChecksum: row.fileChecksum, previewChecksum: row.previewChecksum, claimsChecksum: digest(row.sourceClaims) });
  });

  it("rejects a changed non-target claim, array order, omitted claim or target claim without accepting only a selected-row digest", () => {
    const vault = new SecretVault(randomBytes(32)), row = source(), proof = digestProof(vault, row);
    const changed = row.sourceClaims.map((claim, index) => index === 1 ? { ...claim, quantity: 7 } : claim);
    expect(changed[0]).toEqual(row.sourceClaims[0]);
    for (const claims of [changed, [...row.sourceClaims].reverse(), row.sourceClaims.slice(0, 1),
      row.sourceClaims.map((claim, index) => index === 0 ? { ...claim, rowChecksum: "0".repeat(64) } : claim)])
      rejected(vault, { ...proof, claimsChecksum: digest(claims) });
    rejected(vault, { ...proof, claimsChecksum: digest(row.sourceClaims[0]) });
  });

  it("rejects malformed or substituted digest and header commitments even when an invalid value is independently sealed", () => {
    const vault = new SecretVault(randomBytes(32)), row = source(), proof = digestProof(vault, row);
    for (const claimsChecksum of ["", "0".repeat(63), "0".repeat(65), "A".repeat(64), "g".repeat(64), "0".repeat(64)])
      rejected(vault, { ...proof, claimsChecksum });
    for (const field of ["id", "tenantId", "factoryId", "fileChecksum", "previewChecksum"] as const)
      rejected(vault, { ...proof, [field]: field.endsWith("Checksum") ? "e".repeat(64) : createEntityId() });
    for (const field of ["fileChecksum", "previewChecksum"] as const) {
      const invalid = { ...row, [field]: "not-a-canonical-sha256" };
      rejected(vault, digestProof(vault, invalid));
    }
    const original = vault.withSecret(proof.sourceProof, value => JSON.parse(value) as Record<string, unknown>);
    rejected(vault, { ...proof, claimsChecksum: "invalid", sourceProof: vault.encrypt(canonicalJson({ ...original, claimsChecksum: "invalid" })) });
  });

  it("rejects any missing, extra or differently typed authenticated envelope field with the fixed public error", () => {
    const vault = new SecretVault(randomBytes(32)), proof = digestProof(vault, source());
    const original = vault.withSecret(proof.sourceProof, value => JSON.parse(value) as Record<string, unknown>);
    const missing = { ...original }; delete missing.previewChecksum;
    for (const body of [missing, { ...original, version: 2 }, { ...original, version: "1" }, { ...original, claimsChecksum: 12 },
      { ...original, rawCells: "SYNTHETIC_PRIVATE_DO_NOT_RETURN" }, null, [], "SYNTHETIC_PRIVATE_DO_NOT_RETURN"])
      rejected(vault, { ...proof, sourceProof: vault.encrypt(canonicalJson(body)) });
    rejected(vault, { ...proof, sourceProof: vault.encrypt("SYNTHETIC_NOT_JSON") });
  });

  it("rejects a foreign envelope, another key, tampered GCM bytes and malformed ciphertext without fallback", () => {
    const vault = new SecretVault(randomBytes(32)), row = source(), proof = digestProof(vault, row);
    rejected(new SecretVault(randomBytes(32)), proof);
    rejected(vault, { ...proof, sourceProof: sealFactoryErpProof(vault, { ...row, id: createEntityId() }) });
    const parts = proof.sourceProof.split("."), bytes = Buffer.from(parts[3]!, "base64url");
    bytes[0] = bytes[0]! ^ 1; parts[3] = bytes.toString("base64url");
    rejected(vault, { ...proof, sourceProof: parts.join(".") });
    for (const sourceProof of ["", "v2.invalid.invalid.invalid", "v1.invalid", "v1.invalid.invalid.invalid"])
      rejected(vault, { ...proof, sourceProof });
  });
});
