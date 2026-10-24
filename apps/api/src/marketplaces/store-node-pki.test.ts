import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { StoreNodePki, storeNodePublicKey, storeNodeCertificateTimeArguments } from "./store-node-pki.js";
import { storeNodeCertificateValidity } from "./store-node.types.js";

describe("store node PKI configuration boundary", () => {
  it("is disabled by default and has no certificate or listener options", async () => {
    const pki = await StoreNodePki.fromEnvironment({});
    expect(pki.configuration()).toEqual({ enabled: false, enrollmentOrigin: null, runtimeOrigin: null, caCertificateSha256: null });
    expect(() => pki.caCertificatePem()).toThrow("store_node_runtime_disabled");
    expect(() => pki.runtimeServerOptions()).toThrow("store_node_runtime_disabled");
  });
  it("rejects partial enabling and unsafe TLS-key logging without reading a credential", async () => {
    await expect(StoreNodePki.fromEnvironment({ STORE_NODE_RUNTIME_ENABLED: "yes" })).rejects.toThrow("store_node_configuration_invalid");
    await expect(StoreNodePki.fromEnvironment({ STORE_NODE_RUNTIME_ENABLED: "1" })).rejects.toThrow("store_node_configuration_invalid");
    await expect(StoreNodePki.fromEnvironment({ STORE_NODE_RUNTIME_ENABLED: "1", SSLKEYLOGFILE: "synthetic-secret-path" })).rejects.toThrow("store_node_configuration_invalid");
  });
  it("accepts canonical RSA3072 SPKI and rejects weaker or non-SPKI enrollment keys", () => {
    const valid = generateKeyPairSync("rsa", { modulusLength: 3072 }).publicKey;
    const pem = valid.export({ type: "spki", format: "pem" }).toString();
    expect(storeNodePublicKey(pem).sha256).toMatch(/^[a-f0-9]{64}$/);
    const weak = generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey.export({ type: "spki", format: "pem" }).toString();
    expect(() => storeNodePublicKey(weak)).toThrow();
    expect(() => storeNodePublicKey(valid.export({ type: "pkcs1", format: "pem" }).toString())).toThrow();
  }, 15000);
  it("pins explicit OpenSSL dates to the database claim despite a different process clock", () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-10-22T15:45:12Z"));
    try {
      const issuedAt = new Date("2026-10-22T15:45:00.999Z"), validity = storeNodeCertificateValidity(issuedAt);
      expect(validity.startsAt.toISOString()).toBe("2026-10-22T15:44:30.000Z");
      expect(validity.expiresAt.toISOString()).toBe("2026-10-23T15:44:30.000Z");
      expect(storeNodeCertificateTimeArguments(validity)).toEqual(["-not_before", "20261022154430Z", "-not_after", "20261023154430Z"]);
      expect(storeNodeCertificateTimeArguments(validity)).not.toContain("-days");
      expect(validity.expiresAt.getTime() - validity.startsAt.getTime()).toBe(86400000);
      expect(validity.expiresAt.getTime() - issuedAt.getTime()).toBe(86369001);
    } finally { clock.mockRestore(); }
  });
  it("preserves the fixed 24-hour interval across UTC day and leap-day boundaries", () => {
    const validity = storeNodeCertificateValidity(new Date("2028-03-01T00:00:10.001Z"));
    expect(validity.startsAt.toISOString()).toBe("2028-02-29T23:59:40.000Z");
    expect(validity.expiresAt.toISOString()).toBe("2028-03-01T23:59:40.000Z");
    expect(storeNodeCertificateTimeArguments(validity)).toEqual(["-not_before", "20280229235940Z", "-not_after", "20280301235940Z"]);
    expect(() => storeNodeCertificateValidity(new Date(Number.NaN))).toThrow("store_node_certificate_issue_time_invalid");
    expect(() => storeNodeCertificateTimeArguments(storeNodeCertificateValidity(new Date("+010000-01-01T00:00:00Z"))))
      .toThrow("store_node_certificate_issue_failed");
  });
});
