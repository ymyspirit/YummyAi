import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createEntityId } from "@yummyai/contracts/common/ids";
import { createStoreNodeSealedCredential, openStoreNodeSealedCredential, sealStoreNodeExecutionPayload,
  openStoreNodeExecutionPayload, openStoreNodeExecutionCredentialSeed, storeNodeExecutionPayloadChecksum } from "./store-node-execution-seal.js";

const pins = { id: createEntityId(), nodeId: createEntityId(), certificateGeneration: 1, requestChecksum: "a".repeat(64), claimId: createEntityId() };
const keys = generateKeyPairSync("rsa", { modulusLength: 3072 });
const seed = { account: { authorizationMode: "amazon_private", externalAccountId: "synthetic-seller", grantedScopes: ["product-listing"],
  marketplaceIds: ["synthetic-market"], platform: "amazon", region: "NA" }, credential: { refreshToken: "synthetic-private-refresh" }, etsyAppKeySha256: null } as const;
describe("store node execution envelopes", () => {
  it("binds RSA-OAEP credential delivery to the exact claim and node", () => {
    const created = createStoreNodeSealedCredential({ ...seed, account: { ...seed.account, grantedScopes: [...seed.account.grantedScopes], marketplaceIds: [...seed.account.marketplaceIds] } }, pins, keys.publicKey.export({ type: "spki", format: "pem" }).toString());
    const opened = openStoreNodeSealedCredential(created.sealed, pins, keys.privateKey);
    try {
      expect(opened.payload).toEqual(seed); expect(opened.key.equals(created.key)).toBe(true);
      expect(JSON.stringify(created.sealed)).not.toContain(seed.credential.refreshToken);
      expect(() => openStoreNodeSealedCredential(created.sealed, { ...pins, claimId: createEntityId() }, keys.privateKey)).toThrow("store_node_execution_failed");
    } finally { opened.key.fill(0); created.key.fill(0); }
  });
  it("separates checkpoint and completion and detects modified bytes", () => {
    const key = Buffer.alloc(32, 3);
    try {
      const raw = { credential: { refreshToken: "synthetic-next-refresh" }, expiresAt: "2027-01-01T00:00:00.000Z" };
      const cipher = sealStoreNodeExecutionPayload(raw, key, pins, "checkpoint");
      expect(openStoreNodeExecutionPayload(cipher, key, pins, "checkpoint")).toEqual(raw);
      expect(storeNodeExecutionPayloadChecksum(cipher)).toMatch(/^[a-f0-9]{64}$/);
      expect(() => openStoreNodeExecutionPayload(cipher, key, pins, "completion")).toThrow("store_node_execution_failed");
      expect(() => openStoreNodeExecutionPayload({ ...cipher, ciphertext: (cipher.ciphertext[0] === "A" ? "B" : "A") + cipher.ciphertext.slice(1) }, key, pins, "checkpoint")).toThrow("store_node_execution_failed");
    } finally { key.fill(0); }
  });
  it("lets the issuer authenticate the original credential seed with its transport key while rejecting other purposes", () => {
    const created = createStoreNodeSealedCredential({ ...seed, account: { ...seed.account, grantedScopes: [...seed.account.grantedScopes], marketplaceIds: [...seed.account.marketplaceIds] } }, pins, keys.publicKey.export({ type: "spki", format: "pem" }).toString());
    const cipher = { nonce: created.sealed.nonce, tag: created.sealed.tag, ciphertext: created.sealed.ciphertext };
    try {
      expect(openStoreNodeExecutionCredentialSeed(cipher, created.key, pins)).toEqual(seed);
      expect(openStoreNodeExecutionCredentialSeed(cipher, created.key, pins).credential.refreshToken).toBe("synthetic-private-refresh");
      expect(() => openStoreNodeExecutionPayload(cipher, created.key, pins, "checkpoint")).toThrow("store_node_execution_failed");
      for (const purpose of ["checkpoint", "completion"] as const) {
        const other = sealStoreNodeExecutionPayload(seed, created.key, pins, purpose);
        expect(() => openStoreNodeExecutionCredentialSeed(other, created.key, pins)).toThrow("store_node_execution_failed");
      }
    } finally { created.key.fill(0); }
  });
  it("rejects oversized private payloads before producing a wire envelope", () => {
    const key = Buffer.alloc(32, 7);
    try { expect(() => sealStoreNodeExecutionPayload({ value: "x".repeat(16 * 1024 * 1024) }, key, pins, "completion")).toThrow("store_node_execution_failed"); }
    finally { key.fill(0); }
  });
});
