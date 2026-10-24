import { describe, expect, it } from "vitest";
import { erpSessionAuthority } from "../auth/session.js";
import { StudioRpcSchema } from "./creative-studio.js";
import {
  STUDIO_PERSONAL_VERSION, StudioPersonalInvokeSchema, StudioPersonalReplySchema,
  StudioWorkspaceQuerySchema, StudioWorkspaceSchema, parseStudioPersonalReply,
} from "./studio-personal.js";

const userId = "019a0000-0000-7000-8000-000000000001";
const tenantId = "019a0000-0000-7000-8000-000000000002";
const projectId = "019a0000-0000-7000-8000-000000000003";
const assetId = "019a0000-0000-7000-8000-000000000004";
const authority = erpSessionAuthority({ tenantId, userId, permissions: ["design:read", "design:write"],
  dataScope: "self", permissionScopes: { "design:read": "self", "design:write": "self" } });
const request = StudioRpcSchema.parse({ operation: "state.get", scope: projectId, namespace: "app_state", key: "canvas_store" });
const workspace = () => ({ version: STUDIO_PERSONAL_VERSION, scope: projectId, contextAuthority: authority,
  capabilities: { read: true, save: true, mediaWrite: false, review: false, submit: false, configure: false },
  generation: { enabled: false, code: "operator_paused" } });
const reply = () => ({ version: STUDIO_PERSONAL_VERSION, scope: projectId, contextAuthority: authority,
  operation: "state.get", data: { revision: 3, value: { title: "Synthetic local canvas", nodes: [] } } });

describe("personal Studio boundary", () => {
  it("requires the versioned personal envelope without broadening the original RPC", () => {
    expect(StudioPersonalInvokeSchema.safeParse({ version: 1, contextAuthority: authority, request }).success).toBe(true);
    for (const raw of [request, { version: 0, contextAuthority: authority, request },
      { version: 1, contextAuthority: authority, request, tenantId },
      { version: 1, contextAuthority: authority, request: { ...request, ownerId: userId } }]) {
      expect(StudioPersonalInvokeSchema.safeParse(raw).success).toBe(false);
    }
    expect(StudioRpcSchema.safeParse(request).success).toBe(true);
    expect(StudioRpcSchema.safeParse({ version: 1, contextAuthority: authority, request }).success).toBe(false);
  });

  it("accepts only a canonical authority and a strict scope query", () => {
    expect(StudioWorkspaceQuerySchema.parse({} ).scope).toBe("unassigned");
    expect(StudioWorkspaceQuerySchema.safeParse({ scope: projectId }).success).toBe(true);
    for (const query of [{ scope: projectId, tenantId }, { scope: "../other" }, { scope: [projectId] }]) {
      expect(StudioWorkspaceQuerySchema.safeParse(query).success).toBe(false);
    }
    for (const stamp of ["opaque-token", JSON.stringify({ userId, tenantId }), ` ${authority}`]) {
      expect(StudioPersonalInvokeSchema.safeParse({ version: 1, contextAuthority: stamp, request }).success).toBe(false);
    }
  });

  it("always describes paid execution as paused rather than inferring readiness from capabilities", () => {
    expect(StudioWorkspaceSchema.safeParse(workspace()).success).toBe(true);
    for (const generation of [{ enabled: true, code: "operator_paused" }, { enabled: false, code: "ready" },
      { enabled: false, code: "operator_paused", modelConnected: true }]) {
      expect(StudioWorkspaceSchema.safeParse({ ...workspace(), generation }).success).toBe(false);
    }
    expect(StudioWorkspaceSchema.safeParse({ ...workspace(), capabilities: { ...workspace().capabilities, execute: true } }).success).toBe(false);
    // A well-formed generate request is still representable. The actual owner must reject
    // it before admission; a transport schema is not execution authorization.
    expect(StudioPersonalInvokeSchema.safeParse({ version: 1, contextAuthority: authority,
      request: { operation: "generate", scope: projectId, input: { requestId: "019a0000-0000-7000-8000-000000000005",
        modelId: assetId, capability: "image", selectionRevision: "a".repeat(64), prompt: "Synthetic request that must not execute" } } }).success).toBe(true);
  });

  it("pins a valid read reply to its original operation scope and authority", () => {
    expect(parseStudioPersonalReply(reply(), request, authority).operation).toBe("state.get");
    const otherAuthority = erpSessionAuthority({ tenantId, userId, permissions: ["design:read"], dataScope: "self" });
    for (const raw of [{ ...reply(), scope: "unassigned" }, { ...reply(), contextAuthority: otherAuthority },
      { ...reply(), operation: "state.keys", data: [] }]) {
      expect(() => parseStudioPersonalReply(raw, request, authority)).toThrow();
    }
  });

  it("does not accept media or mutation results as document reads", () => {
    const media = { ...reply(), data: { revision: 2, media: { contentBase64: "aGVsbG8=", mediaType: "image/png" }, assetId } };
    expect(StudioPersonalReplySchema.safeParse(media).success).toBe(true);
    for (const data of [{ ...media.data, value: {} }, { revision: 1, media: media.data.media },
      { revision: -1, value: null }, { revision: 2, assetId }, { revision: 1, value: null, objectKey: "private/path" }]) {
      expect(StudioPersonalReplySchema.safeParse({ ...reply(), data }).success).toBe(false);
    }
    expect(StudioPersonalReplySchema.safeParse({ ...reply(), operation: "state.set", data: { revision: 1, assetId: null } }).success).toBe(true);
    expect(StudioPersonalReplySchema.safeParse({ ...reply(), operation: "state.remove", data: { revision: 2, assetId } }).success).toBe(false);
  });

  it("rejects credential-bearing persisted documents in object and serialized forms", () => {
    for (const value of [{ nested: { accessToken: "synthetic-forbidden" } },
      JSON.stringify({ nodes: [{ password: "synthetic-forbidden" }] })]) {
      expect(StudioPersonalReplySchema.safeParse({ ...reply(), data: { revision: 1, value } }).success).toBe(false);
    }
    expect(StudioPersonalReplySchema.safeParse({ ...reply(), data: { revision: 1, value: null } }).success).toBe(true);
  });

  it("validates preview type and finite result schemas without accepting provider internals", () => {
    const preview = { ...reply(), operation: "asset.preview", data: { contentBase64: "aGVsbG8=", mediaType: "image/webp" } };
    expect(StudioPersonalReplySchema.safeParse(preview).success).toBe(true);
    expect(StudioPersonalReplySchema.safeParse({ ...preview, data: { ...preview.data, mediaType: "image/png" } }).success).toBe(false);
    expect(StudioPersonalReplySchema.safeParse({ ...reply(), operation: "models", data: [{ id: assetId, label: "Synthetic",
      model: "synthetic-only", capability: "image", selectionRevision: "a".repeat(64), providerLabel: "Synthetic metadata", isDefault: false }] }).success).toBe(true);
    for (const raw of [{ ...reply(), token: "synthetic-forbidden" }, { ...reply(), operation: "unknown" },
      { ...reply(), operation: "models", data: [{ id: assetId, apiKey: "synthetic-forbidden" }] }]) {
      expect(StudioPersonalReplySchema.safeParse(raw).success).toBe(false);
    }
  });
});
