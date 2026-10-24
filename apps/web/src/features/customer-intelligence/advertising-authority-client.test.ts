import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { erpSessionAuthority } from "@yummyai/contracts/auth/session";
import { AdRequestError, adCheckAuthority, adDenied, adDownload, adRequest } from "./advertising-client";

const account = "019b0000-0000-7000-8000-000000000001";
const original = { accountId: account, idempotencyKey: "synthetic-original-observation", source: "Synthetic source, no marketplace connection" };
const authority = erpSessionAuthority({ tenantId: account, userId: "019b0000-0000-7000-8000-000000000002", permissions: ["customer_intelligence:read"], dataScope: "tenant" });
const identity = { authority, preferenceScope: `${account}:synthetic`, localDevelopment: false };
const transport = vi.fn(), dispatch = vi.fn();
beforeEach(() => { transport.mockReset(); dispatch.mockReset(); vi.stubGlobal("fetch", transport); vi.stubGlobal("window", { dispatchEvent: dispatch }); });
afterEach(() => vi.unstubAllGlobals());

describe("advertising personal client authority and unknown-operation semantics", () => {
  it("accepts only the actual current ERP authority and clears stale or absent identity", () => {
    expect(() => adCheckAuthority({ contextAuthority: authority }, identity)).not.toThrow(); expect(dispatch).not.toHaveBeenCalled();
    for (const changed of [{ ...identity, authority: null }, { ...identity, authority: "different-identity" }]) {
      expect(() => adCheckAuthority({ contextAuthority: authority }, changed)).toThrow(AdRequestError);
    }
    expect(dispatch).toHaveBeenCalledTimes(2); expect(dispatch.mock.calls.every(([event]) => event.type === "focus")).toBe(true);
    expect(() => adCheckAuthority({ contextAuthority: "a".repeat(64) }, identity)).toThrow(AdRequestError);
  });
  it("keeps the explicit local-development boundary separate from a missing personal identity", () => {
    expect(() => adCheckAuthority({ contextAuthority: authority }, { ...identity, localDevelopment: true, authority: null })).not.toThrow();
    expect(() => adCheckAuthority({ contextAuthority: authority }, { ...identity, localDevelopment: false, authority: null })).toThrow(AdRequestError);
  });
  it("uses only the personal BFF and forwards the original body once without inventing authorization or tenant fields", async () => {
    transport.mockResolvedValue(Response.json({ id: account }));
    expect(await adRequest("observations", original)).toEqual({ id: account }); expect(transport).toHaveBeenCalledTimes(1);
    const [path, init] = transport.mock.calls[0]!; expect(path).toBe("/api/advertising/observations");
    expect(init).toMatchObject({ method: "POST", credentials: "same-origin", redirect: "error", cache: "no-store" });
    expect(JSON.parse(init.body)).toEqual(original); expect(new Headers(init.headers).has("authorization")).toBe(false);
  });
  it("does not retry a lost response automatically and preserves a deliberate retry's exact original body and key", async () => {
    transport.mockRejectedValueOnce(new Error("SYNTHETIC-PRIVATE-TRANSPORT-DETAIL"));
    await expect(adRequest("observations", original)).rejects.toMatchObject({ status: 0, message: "本次操作结果尚未确认 请保留原正文和原键重试" });
    expect(transport).toHaveBeenCalledTimes(1); transport.mockResolvedValueOnce(Response.json({ id: account }));
    await adRequest("observations", original); expect(transport).toHaveBeenCalledTimes(2);
    expect(transport.mock.calls.map(([, init]) => JSON.parse(init.body))).toEqual([original, original]); expect(dispatch).not.toHaveBeenCalled();
  });
  it.each([401, 403])("classifies HTTP %s as authority loss and rechecks the personal session without reflecting private details", async status => {
    transport.mockResolvedValue(Response.json({ message: "SYNTHETIC-PRIVATE-SOURCE", code: "safe_public_code" }, { status }));
    let failure: unknown; try { await adRequest("workspace"); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(AdRequestError); expect(failure).toMatchObject({ status }); expect(adDenied(failure)).toBe(true);
    expect((failure as Error).message).not.toContain("SYNTHETIC-PRIVATE"); expect(dispatch).toHaveBeenCalledTimes(1); expect(transport).toHaveBeenCalledTimes(1);
  });
  it("distinguishes an authority_changed race from an ordinary business conflict", async () => {
    transport.mockResolvedValueOnce(Response.json({ code: "authority_changed", message: "SYNTHETIC-PRIVATE-AUTHORITY" }, { status: 409 }));
    let changed: unknown; try { await adRequest("observations", original); } catch (error) { changed = error; }
    expect(changed).toMatchObject({ status: 409, code: "authority_changed" }); expect(adDenied(changed)).toBe(true); expect(dispatch).toHaveBeenCalledTimes(1);
    transport.mockResolvedValueOnce(Response.json({ message: "SYNTHETIC-PRIVATE-CONFLICT" }, { status: 409 }));
    let conflict: unknown; try { await adRequest("observations", original); } catch (error) { conflict = error; }
    expect(adDenied(conflict)).toBe(false); expect(dispatch).toHaveBeenCalledTimes(1);
  });
  it("does not convert malformed successful JSON into a valid receipt", async () => {
    transport.mockResolvedValue(new Response("not JSON", { status: 200 }));
    await expect(adRequest("workspace")).rejects.toMatchObject({ status: 502 }); expect(transport).toHaveBeenCalledTimes(1);
  });
  it("does not return a download after current Read denial or an unexpected document type", async () => {
    transport.mockResolvedValueOnce(new Response("synthetic private bytes", { status: 403 }));
    await expect(adDownload(`imports/${account}/source`)).rejects.toMatchObject({ status: 403 }); expect(dispatch).toHaveBeenCalledTimes(1);
    transport.mockResolvedValueOnce(new Response("synthetic html", { headers: { "content-type": "text/html" } }));
    await expect(adDownload(`imports/${account}/source`)).rejects.toMatchObject({ status: 502 }); expect(transport).toHaveBeenCalledTimes(2);
  });
  it("retains validated CSV bytes without treating them as a new write or opening a marketplace route", async () => {
    const bytes = new TextEncoder().encode("\ufeff日期,金额\r\n2026-09-01,10.00\r\n");
    transport.mockResolvedValue(new Response(bytes, { headers: { "content-type": "text/csv; charset=utf-8" } }));
    const result = await adDownload(`imports/${account}/source`); expect(new Uint8Array(await result.arrayBuffer())).toEqual(bytes);
    expect(transport).toHaveBeenCalledTimes(1); expect(transport.mock.calls[0]![1]).toMatchObject({ credentials: "same-origin", cache: "no-store" });
  });
  it("download authority race: recognizes only bounded literal authority_changed and keeps ordinary conflicts distinct", async () => {
    transport.mockResolvedValueOnce(Response.json({ code: "authority_changed", message: "SYNTHETIC-PRIVATE-DOWNLOAD-DETAIL" }, { status: 409 }));
    let changed: unknown; try { await adDownload(`imports/${account}/source`); } catch (error) { changed = error; }
    expect(changed).toMatchObject({ status: 409, code: "authority_changed" }); expect(adDenied(changed)).toBe(true);
    expect((changed as Error).message).not.toContain("SYNTHETIC-PRIVATE"); expect(dispatch).toHaveBeenCalledTimes(1);
    for (const body of [{ code: "another_business_conflict" }, { code: "authority_changed", padding: "x".repeat(5000) }]) {
      transport.mockResolvedValueOnce(Response.json(body, { status: 409 }));
      let conflict: unknown; try { await adDownload(`imports/${account}/source`); } catch (error) { conflict = error; }
      expect(conflict).toMatchObject({ status: 409 }); expect(adDenied(conflict)).toBe(false);
    }
    expect(dispatch).toHaveBeenCalledTimes(1); expect(transport).toHaveBeenCalledTimes(3);
  });
});
