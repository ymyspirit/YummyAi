import { describe, expect, it, vi } from "vitest";
import { decodePodResponse, hashPodResponse, PodResponseInvalidError, readBoundedPodResponse, type PodArtworkResponseCheckpoint } from "./pod-artwork-response.js";

const checkpoint = (payload: unknown): PodArtworkResponseCheckpoint => {
  const rawBody = JSON.stringify(payload);
  return { version: "pod-response-checkpoint-v1", kind: "http", rawBody, status: 200, deploymentId: "synthetic-v1", maxOutputBytes: 4, receipt: { version: "pod-response-v1", responseChecksum: hashPodResponse(rawBody), receivedAt: new Date().toISOString(), providerRequestId: null, modelKey: "synthetic", modelVersion: "v1", costUsd: null, metadataValid: true } };
};
const output = (dataBase64: string) => ({ dataBase64, mediaType: "text/plain", role: "effect", fileName: "synthetic.txt", metadata: { aiInference: "none" } });
const payload = (outputs: unknown[]) => ({ outputs, modelKey: "synthetic", modelVersion: "v1", qualityCheckSnapshot: {}, partial: false });

describe("bounded immutable POD response decoding", () => {
  it("cancels an oversized streaming response without returning or quoting its body", async () => {
    const cancel = vi.fn(), body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(Buffer.from("private")); controller.enqueue(Buffer.from(" response")); }, cancel });
    await expect(readBoundedPodResponse(new Response(body), 8)).rejects.toThrow("POD_RESPONSE_TOO_LARGE"); expect(cancel).toHaveBeenCalledOnce();
  });
  it("rejects an oversized declared length before consuming response bytes", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ cancel });
    await expect(readBoundedPodResponse(new Response(body, { headers: { "content-length": "1000" } }), 16)).rejects.toThrow("POD_RESPONSE_TOO_LARGE"); expect(cancel).toHaveBeenCalledOnce();
  });
  it("enforces canonical base64 and an aggregate decoded-byte limit", () => {
    expect(() => decodePodResponse(checkpoint(payload([output("YQ!")])))).toThrow(PodResponseInvalidError);
    expect(() => decodePodResponse(checkpoint(payload([output("YWJj"), output("YWJj")])))).toThrow("byte limit");
    expect(decodePodResponse(checkpoint(payload([output("YWJj")]))).outputs[0]?.bytes).toEqual(Uint8Array.from(Buffer.from("abc")));
  });
  it("rejects a different raw response or unsuccessful HTTP status while keeping the receipt separate", () => {
    const saved = checkpoint(payload([output("YQ==")]));
    expect(() => decodePodResponse({ ...saved, rawBody: saved.rawBody + " " })).toThrow(PodResponseInvalidError);
    expect(() => decodePodResponse({ ...saved, status: 503 })).toThrow(PodResponseInvalidError);
  });
});
