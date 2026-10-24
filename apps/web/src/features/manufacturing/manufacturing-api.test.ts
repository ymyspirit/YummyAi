import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { erpSessionAuthority } from "@yummyai/contracts/auth/session";
import { manufacturingRequest, ManufacturingContextChanged, ManufacturingRequestError } from "./manufacturing-api";

const authority = erpSessionAuthority({ tenantId: "01a15360-2f92-7d8d-ac3f-3cbacccfcaf9", userId: "01a15360-2f93-7bb8-8285-33e2f81b80ae", permissions: ["product:read"], dataScope: "tenant" });
const Payload = z.object({ versionNumber: z.int().positive() }).strict();
const respond = (body: unknown, status = 200) => vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(body, { status })));
afterEach(() => vi.unstubAllGlobals());
describe("manufacturing response authority and uncertain writes", () => {
  it("accepts the canonical structured authority rather than expecting a digest", async () => {
    respond({ contextAuthority: authority, data: { versionNumber: 2 } });
    expect(await manufacturingRequest("/test", Payload, authority, false)).toEqual({ versionNumber: 2 });
    expect(fetch).toHaveBeenCalledWith("/api/manufacturing-recipes/test", expect.objectContaining({ method: "GET", cache: "no-store" }));
  });
  it("hides a changed authority even when that response also has an invalid payload", async () => {
    respond({ contextAuthority: authority + "changed", data: { versionNumber: -1 } });
    await expect(manufacturingRequest("/test", Payload, authority, false)).rejects.toBeInstanceOf(ManufacturingContextChanged);
  });
  it("keeps a successful but unverifiable command uncertain instead of issuing a replacement", async () => {
    respond({ contextAuthority: authority, data: { versionNumber: 0 } }, 201);
    await expect(manufacturingRequest("/test", Payload, authority, false, { body: { idempotencyKey: "original" } })).rejects.toMatchObject({ uncertain: true, status: null });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("distinguishes failed read-only estimates from mutations when the connection is lost", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Synthetic lost connection")));
    await expect(manufacturingRequest("/test", Payload, authority, false, { body: {}, readOnly: true })).rejects.toMatchObject({ uncertain: false });
    await expect(manufacturingRequest("/test", Payload, authority, false, { body: {} })).rejects.toMatchObject({ uncertain: true });
  });
  it("returns current access failures as definitive HTTP errors and never trusts undeclared transport fields", async () => {
    respond({ message: "Synthetic permission withdrawn" }, 403);
    await expect(manufacturingRequest("/test", Payload, authority, false, { body: {} })).rejects.toMatchObject({ status: 403, uncertain: false });
    respond({ contextAuthority: authority, data: { versionNumber: 1 }, callerSelectedTenant: "foreign" });
    await expect(manufacturingRequest("/test", Payload, authority, false)).rejects.toBeInstanceOf(ManufacturingRequestError);
  });
  it("keeps a post-submission authority change distinct from a stale-version rejection", async () => {
    respond({ message: "Synthetic authority changed after the command", code: "authority_changed" }, 409);
    await expect(manufacturingRequest("/test", Payload, authority, false, { body: {} })).rejects.toBeInstanceOf(ManufacturingContextChanged);
    respond({ message: "Synthetic stale version" }, 409);
    await expect(manufacturingRequest("/test", Payload, authority, false, { body: {} })).rejects.toMatchObject({ status: 409, uncertain: false });
  });
});
