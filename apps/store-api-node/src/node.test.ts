import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { storeNodeOrigin } from "./config.js";
import { generateStoreNodeKeys, loadStoreNodeKey, openStoreNodeState, sealStoreNodeState } from "./identity.js";

const passphrase = "synthetic-store-node-passphrase-for-unit";
describe("store node local identity", () => {
  it("accepts only HTTPS origins without credentials, path, query, or fragment", () => {
    expect(storeNodeOrigin("https://127.0.0.1:8142")).toBe("https://127.0.0.1:8142");
    for (const value of ["http://127.0.0.1:8142", "https://synthetic.invalid/path", "https://user:secret@synthetic.invalid", "https://synthetic.invalid?token=secret", "https://synthetic.invalid/#x"])
      expect(() => storeNodeOrigin(value)).toThrow("store_node_origin_invalid");
  });
  it("generates encrypted RSA3072 identity and rejects a wrong passphrase", async () => {
    const keys = await generateStoreNodeKeys(passphrase);
    expect(keys.privateKeyPem).toContain("BEGIN ENCRYPTED PRIVATE KEY");
    expect(keys.privateKeyPem).not.toContain("BEGIN PRIVATE KEY");
    const key = loadStoreNodeKey(keys.publicKeyPem, keys.privateKeyPem, passphrase);
    expect(key.asymmetricKeyDetails?.modulusLength).toBe(3072);
    expect(keys.publicKeySpkiSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(() => loadStoreNodeKey(keys.publicKeyPem, keys.privateKeyPem, "synthetic-wrong-passphrase")).toThrow("store_node_identity_invalid");
  }, 15000);
  it("authenticates persisted original pending sequence and its public-key binding", async () => {
    const spki = createHash("sha256").update("synthetic-spki").digest("hex");
    const original = { pending: { sessionId: "synthetic-original-session", sequence: 3 }, privateField: "synthetic-private-payload" };
    const cipher = await sealStoreNodeState(original, passphrase, spki);
    expect(cipher.toString()).not.toContain(original.privateField);
    expect(await openStoreNodeState(cipher, passphrase, spki)).toEqual(original);
    await expect(openStoreNodeState(cipher, passphrase, "0".repeat(64))).rejects.toThrow("store_node_identity_invalid");
    await expect(openStoreNodeState(cipher, "synthetic-wrong-passphrase", spki)).rejects.toThrow("store_node_identity_invalid");
    const changed = JSON.parse(cipher.toString()) as { cipher: string }; changed.cipher = Buffer.alloc(Buffer.from(changed.cipher, "base64").length).toString("base64");
    await expect(openStoreNodeState(Buffer.from(JSON.stringify(changed)), passphrase, spki)).rejects.toThrow("store_node_identity_invalid");
    cipher.fill(0);
  });

});
