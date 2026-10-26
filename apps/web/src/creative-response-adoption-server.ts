import { erpSessionAuthority } from "@yummyai/contracts/auth/session";
import {
  CREATIVE_RESPONSE_ADOPTION_ARTIFACT_HEADER, CREATIVE_RESPONSE_ADOPTION_BASIS_HEADER, CREATIVE_RESPONSE_ADOPTION_CHECKSUM_HEADER,
  CREATIVE_RESPONSE_ADOPTION_PREVIEW_MAX_BYTES, CreativeResponseAdoptionCancelSchema, CreativeResponseAdoptionCommandSchema,
  CreativeResponseAdoptionRequestViewSchema, CreativeResponseAdoptionWorkspaceSchema,
} from "@yummyai/contracts/harness/creative-response-adoption";
import { Permission } from "@yummyai/authz/permissions";
import { CreativeOwnerResponseAdoptionRequestSchema, CreativeOwnerResponseAdoptionWorkspaceSchema } from "@yummyai/contracts/harness/creative-owner-response-adoption";
import { z } from "zod";
import { readStudioJson, requireStudioPersonalIdentity, studioPersonalException, studioPersonalFailure } from "./creative-studio-personal-server";
import { assertErpIdentityCurrent } from "./erp-auth/server";
import { PersonalSessionError } from "./identity/core";
import { apiFetch } from "./server-api";
import { isSameOriginRequest } from "./same-origin-request";

const id = "[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const requestId = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const route = new RegExp(`^(${id})/((?:owner-)?response-adoption(?:/preview)?|(?:owner-)?response-adoptions(?:/by-request/(${requestId})|/(${id})/cancel)?)$`, "i");
const safeCodes = new Set(["CREATIVE_ADOPTION_ARCHIVE_UNAVAILABLE", "CREATIVE_ADOPTION_ARCHIVE_INVALID", "CREATIVE_ADOPTION_SCAN_FAILED",
  "CREATIVE_ADOPTION_ARTIFACT_IO_FAILED", "CREATIVE_ADOPTION_BASIS_CHANGED", "CREATIVE_ADOPTION_BLOCKED", "CREATIVE_ADOPTION_LEASE_LOST",
  "CREATIVE_ADOPTION_PROCESSING_FAILED", "CREATIVE_ADOPTION_CONFLICT", "CREATIVE_ADOPTION_NOT_FOUND", "authority_changed"]);
for (const code of ["ARCHIVE_UNAVAILABLE", "ARCHIVE_INVALID", "SCAN_FAILED", "ARTIFACT_IO_FAILED", "BASIS_CHANGED", "BLOCKED", "LEASE_LOST", "PROCESSING_FAILED", "CONFLICT", "NOT_FOUND"])
  safeCodes.add(`CREATIVE_OWNER_ADOPTION_${code}`);
const imageTypes = new Set(["image/png", "image/jpeg", "image/webp", "image/tiff"]);
const hash = /^[a-f0-9]{64}$/;

export function isCreativeResponseAdoptionPath(path: string) { return route.test(path); }

/** Buffer only bounded original bytes, then recheck the live personal session.
 * No stale response body is streamed into another user's session. */
export async function creativeResponseAdoptionProxy(request: Request, path: string, method: "GET" | "POST") {
  const match = route.exec(path);
  if (!match) return studioPersonalFailure(404);
  const executionId = match[1]!, target = match[2]!, lookupRequest = match[3], adoptionId = match[4];
  const generic = target.startsWith("owner-"), resource = generic ? target.slice(6) : target;
  const isWorkspace = resource === "response-adoption", isPreview = resource === "response-adoption/preview";
  if ((isWorkspace || isPreview || lookupRequest ? "GET" : "POST") !== method) return studioPersonalFailure(404);
  if (request.headers.get("sec-fetch-site") === "cross-site" || method === "POST" && !isSameOriginRequest(request)) return studioPersonalFailure(403);
  const params = new URL(request.url).searchParams;
  if ([...params.keys()].some(key => params.getAll(key).length !== 1)) return studioPersonalFailure(400);
  let basis: string | undefined;
  if (isPreview) {
    const parsed = z.object({ basis: z.string().regex(hash) }).strict().safeParse(Object.fromEntries(params));
    if (!parsed.success) return studioPersonalFailure(400); basis = parsed.data.basis;
  } else if (params.size) return studioPersonalFailure(400);
  try {
    const identity = await requireStudioPersonalIdentity(request, [Permission.DesignRead, Permission.AssetRead]);
    const authority = erpSessionAuthority(identity.view);
    let command: ReturnType<typeof CreativeResponseAdoptionCommandSchema.parse> | undefined;
    let cancelledRequest: string | undefined;
    let body: string | undefined;
    if (method === "POST") {
      const value = await readStudioJson(request, 4096);
      if (adoptionId) {
        const parsed = (generic ? CreativeResponseAdoptionCommandSchema : CreativeResponseAdoptionCancelSchema).safeParse(value);
        if (!parsed.success) return studioPersonalFailure(400); cancelledRequest = parsed.data.requestId; body = JSON.stringify(parsed.data);
        if (generic) command = CreativeResponseAdoptionCommandSchema.parse(parsed.data);
      } else {
        const parsed = CreativeResponseAdoptionCommandSchema.safeParse(value);
        if (!parsed.success) return studioPersonalFailure(400); command = parsed.data; body = JSON.stringify(command);
      }
    }
    await assertErpIdentityCurrent(identity);
    const response = await apiFetch(`${identity.service.configuration.apiBase.replace(/\/$/, "")}/v1/creative-executions/${path}${basis ? `?basis=${basis}` : ""}`, {
      method, body, headers: { "x-yummyai-context-authority": authority, ...(body ? { "content-type": "application/json" } : {}) },
      cache: "no-store", redirect: "error", signal: method === "GET"
        ? AbortSignal.any([request.signal, AbortSignal.timeout(100_000)]) : AbortSignal.timeout(100_000),
    });
    if (!response.ok) {
      let code: string | undefined;
      try {
        const raw = await readStudioJson(response, 8192) as { code?: unknown };
        if (typeof raw?.code === "string" && safeCodes.has(raw.code)) code = raw.code;
      } catch { /* Provider and internal diagnostics never cross this boundary. */ }
      await assertErpIdentityCurrent(identity);
      return studioPersonalFailure(response.status, undefined, code);
    }
    if (![200, 201].includes(response.status) || response.headers.get("x-yummyai-context-authority") !== authority) {
      await response.body?.cancel(); throw new PersonalSessionError(409, "authority_changed");
    }
    const headers = new Headers({ "cache-control": "private, no-store", "x-content-type-options": "nosniff", "x-yummyai-context-authority": authority });
    if (isPreview) {
      const mediaType = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
      const originalChecksum = response.headers.get(CREATIVE_RESPONSE_ADOPTION_CHECKSUM_HEADER);
      const artifactChecksum = response.headers.get(CREATIVE_RESPONSE_ADOPTION_ARTIFACT_HEADER);
      if (!mediaType || !imageTypes.has(mediaType) || response.headers.get(CREATIVE_RESPONSE_ADOPTION_BASIS_HEADER) !== basis
        || !originalChecksum || !hash.test(originalChecksum) || !artifactChecksum || !hash.test(artifactChecksum)) {
        await response.body?.cancel(); return studioPersonalFailure(502);
      }
      const bytes = await readOriginalBytes(response, request.signal);
      const actualChecksum = await crypto.subtle.digest("SHA-256", bytes);
      if (Buffer.from(actualChecksum).toString("hex") !== artifactChecksum) return studioPersonalFailure(502);
      await assertErpIdentityCurrent(identity);
      headers.set("content-type", mediaType); headers.set("content-length", String(bytes.byteLength));
      headers.set(CREATIVE_RESPONSE_ADOPTION_BASIS_HEADER, basis!);
      headers.set(CREATIVE_RESPONSE_ADOPTION_CHECKSUM_HEADER, originalChecksum);
      headers.set(CREATIVE_RESPONSE_ADOPTION_ARTIFACT_HEADER, artifactChecksum);
      return new Response(bytes, { status: 200, headers });
    }
    const raw = await readStudioJson(response, 128 * 1024);
    const result = generic ? isWorkspace ? CreativeOwnerResponseAdoptionWorkspaceSchema.parse(raw) : CreativeOwnerResponseAdoptionRequestSchema.parse(raw)
      : isWorkspace ? CreativeResponseAdoptionWorkspaceSchema.parse(raw) : CreativeResponseAdoptionRequestViewSchema.parse(raw);
    if (result.executionId !== executionId || !isWorkspace && "requestId" in result && lookupRequest && result.requestId !== lookupRequest
      || isWorkspace && "requests" in result && result.requests.some(value => value.executionId !== executionId)
      || !isWorkspace && "id" in result && adoptionId && result.id !== adoptionId
      || cancelledRequest && "requestId" in result && result.requestId !== cancelledRequest
      || command && "command" in result && JSON.stringify(result.command) !== JSON.stringify(command)) return studioPersonalFailure(502);
    await assertErpIdentityCurrent(identity);
    return Response.json(result, { status: 200, headers });
  } catch (cause) { return studioPersonalException(cause, request); }
}

async function readOriginalBytes(response: Response, requestSignal: AbortSignal) {
  const limit = CREATIVE_RESPONSE_ADOPTION_PREVIEW_MAX_BYTES, declared = response.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || !Number.isSafeInteger(Number(declared)) || Number(declared) > limit)) {
    await response.body?.cancel(); throw new Error("creative_preview_size_invalid");
  }
  const reader = response.body?.getReader(); if (!reader) throw new Error("creative_preview_body_missing");
  const signal = AbortSignal.any([requestSignal, AbortSignal.timeout(90_000)]);
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", abort, { once: true });
  const chunks: Uint8Array[] = []; let length = 0;
  try {
    for (;;) {
      signal.throwIfAborted(); const part = await reader.read(); signal.throwIfAborted();
      if (part.done) break; length += part.value.byteLength;
      if (length > limit) throw new Error("creative_preview_size_invalid"); chunks.push(part.value);
    }
    if (!length || declared !== null && length !== Number(declared)) throw new Error("creative_preview_body_incomplete");
    return new Uint8Array(Buffer.concat(chunks));
  } catch (cause) { await reader.cancel().catch(() => {}); throw cause; }
  finally { signal.removeEventListener("abort", abort); reader.releaseLock(); }
}
