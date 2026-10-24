import { describe, expect, it } from "vitest";
import { nodeContext, nodeCreated, nodeIds, nodePublicDigest, nodePublicKey, nodeWorkspace } from "./store-node.test-fixture";
import { normalizeStoreNodePublicKey, StoreNodeRequestError, storeNodeDenied, storeNodeEnrollmentMatches, storeNodeErrorMessage,
  storeNodeMutationMatches, storeNodeOperationAllowed, storeNodePublicKeyDigest, storeNodeReachability, storeNodeWorkspaceMatches } from "./store-node-lifecycle";

describe("store node lifecycle safety", () => {
  it("accepts only public PEM and hashes the real SPKI bytes regardless of line endings", async () => {
    expect(normalizeStoreNodePublicKey(nodePublicKey.replace(/\n/g, "\r\n"))).toBe(nodePublicKey);
    expect(await storeNodePublicKeyDigest(nodePublicKey)).toBe(nodePublicDigest);
    expect(await storeNodePublicKeyDigest(nodePublicKey.replace(/\n/g, "\r\n"))).toBe(nodePublicDigest);
    for (const input of [nodePublicKey.replace("PUBLIC KEY", "PRIVATE KEY"), "not a public key", "A".repeat(8193)])
      expect(() => normalizeStoreNodePublicKey(input)).toThrow(StoreNodeRequestError);
  });
  it("binds node metadata to the exact member, account and authority and rejects duplicate identities", () => {
    const value = nodeWorkspace(); expect(storeNodeWorkspaceMatches(value, nodeContext)).toBe(true);
    expect(storeNodeWorkspaceMatches(value, { ...nodeContext, accountId: nodeContext.accountId.toUpperCase() })).toBe(true);
    for (const context of [{ ...nodeContext, accountId: nodeIds.other }, { ...nodeContext, actorId: nodeIds.other },
      { ...nodeContext, tenantId: nodeIds.other }, { ...nodeContext, authority: "f".repeat(64) }])
      expect(storeNodeWorkspaceMatches(value, context)).toBe(false);
    expect(storeNodeWorkspaceMatches({ ...value, nodes: [...value.nodes, value.nodes[0]!] }, nodeContext)).toBe(false);
  });
  it("refuses enrollment substitution and checks the actual node for bind or revoke receipts", async () => {
    const created = nodeCreated(); expect(await storeNodeEnrollmentMatches(created, nodeIds.node)).toBe(true);
    for (const enrollment of [{ ...created.enrollment, accountId: nodeIds.other }, { ...created.enrollment, nodeId: nodeIds.other },
      { ...created.enrollment, certificateGeneration: 2 }, { ...created.enrollment, publicKeySpkiSha256: "f".repeat(64) },
      { ...created.enrollment, enrollmentOrigin: "https://different.synthetic.test" }, { ...created.enrollment, expiresAt: "2026-10-22T10:20:00.000Z" },
      { ...created.enrollment, ticketToken: `stn_${nodeIds.other}.${"a".repeat(43)}` }, { ...created.enrollment, caCertificatePem: created.enrollment.caCertificatePem.replace("AAAA", "BBBB") }])
      expect(await storeNodeEnrollmentMatches({ ...created, enrollment })).toBe(false);
    const consumed = nodeCreated(); consumed.workspace.nodes[0]!.ticketState = "consumed";
    expect(await storeNodeEnrollmentMatches(consumed)).toBe(false);
    const value = nodeWorkspace(), fence = { expectedAuthorizationGeneration: nodeIds.generation, expectedBindingRevision: 0, expectedCertificateGeneration: 1 };
    expect(storeNodeMutationMatches(value, "revoke", fence, nodeIds.node)).toBe(false);
    value.nodes[0]!.status = "revoked"; expect(storeNodeMutationMatches(value, "revoke", fence, nodeIds.node)).toBe(true);
    expect(storeNodeMutationMatches(value, "bind", { ...fence, nodeId: nodeIds.node }, nodeIds.node)).toBe(false);
  });
  it("does not equate unknown outcomes or an expired heartbeat with successful execution", () => {
    expect(storeNodeDenied(new StoreNodeRequestError(409, "store_node_binding_changed"))).toBe(false);
    expect(storeNodeDenied(new StoreNodeRequestError(409, "store_node_member_changed"))).toBe(true);
    expect(storeNodeErrorMessage(new StoreNodeRequestError(0, undefined, true))).toContain("结果未知");
    expect(storeNodeErrorMessage(new StoreNodeRequestError(503, "store_node_not_configured"))).toContain("尚未启用");
    expect(storeNodeErrorMessage(new StoreNodeRequestError(409, "store_node_ticket_not_replayable", true))).toContain("票据不会重新显示");
    const value = nodeWorkspace().nodes[0]!, now = Date.parse("2026-10-22T10:00:00.000Z");
    const online = { ...value, status: "enrolled" as const, reachability: "online" as const, sessionExpiresAt: "2026-10-22T10:01:00.000Z" };
    expect(storeNodeReachability(online, now)).toBe("在线"); expect(storeNodeReachability(online, now + 60000)).toBe("离线");
    expect(storeNodeReachability({ ...online, status: "revoked" }, now)).toBe("已撤销");
    expect(nodeWorkspace().execution.supportsPlatformOperations).toBe(false);
  });
  it("keeps certificate revocation available when node configuration is disabled without granting other writes", () => {
    const value = nodeWorkspace(); value.configuration.enabled = false;
    expect(storeNodeOperationAllowed(value, "revoke")).toBe(true);
    for (const operation of ["create", "reissue", "bind"] as const) expect(storeNodeOperationAllowed(value, operation)).toBe(false);
    value.access.authorize = false;
    expect(storeNodeOperationAllowed(value, "revoke")).toBe(false);
    value.access.authorize = true; value.access.manage = false;
    expect(storeNodeOperationAllowed(value, "revoke")).toBe(false);
  });
});
