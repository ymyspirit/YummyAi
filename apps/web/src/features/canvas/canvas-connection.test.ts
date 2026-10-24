import { randomUUID } from "node:crypto";
import { createEntityId } from "@yummyai/contracts";
import { CANVAS_BRIDGE } from "@yummyai/contracts/pod/canvas-bridge";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connectCanvas } from "./canvas-connection";

describe("ERP window bridge security boundary", () => {
  let listener: (event: MessageEvent) => Promise<void>;
  const fetchMock = vi.fn<typeof fetch>();
  const popup = { postMessage: vi.fn() } as unknown as Window;
  const origin = "http://127.0.0.1:4175", channelId = randomUUID(), briefId = createEntityId();
  const onStatus = vi.fn(), onResult = vi.fn();
  const envelope = { channel: "yummyai-canvas", protocolVersion: 1, channelId };
  const ready = { type: "ready", upstreamVersion: CANVAS_BRIDGE.upstreamVersion, pluginVersion: CANVAS_BRIDGE.pluginVersion };
  function send(data: object, source = popup, from = origin) { return listener({ data: { ...envelope, requestId: randomUUID(), ...data }, source, origin: from } as MessageEvent); }
  beforeEach(() => {
    vi.clearAllMocks(); fetchMock.mockResolvedValue(Response.json({ id: briefId }));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("window", { addEventListener: (_: string, fn: typeof listener) => { listener = fn; }, removeEventListener: vi.fn() });
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

  it("ignores foreign windows, origins and channels before any privileged fetch", async () => {
    const close = connectCanvas({ popup, origin, channelId, briefId, onStatus, onResult });
    await send(ready, {} as Window); await send(ready, popup, "https://attacker.test");
    await send({ ...ready, channelId: randomUUID() });
    expect(popup.postMessage).not.toHaveBeenCalled(); expect(fetchMock).not.toHaveBeenCalled();
    await send({ type: "brief.read" });
    expect(popup.postMessage).toHaveBeenLastCalledWith(expect.objectContaining({ ok: false }), origin);
    await send({ ...ready, upstreamVersion: "v99.0.0" });
    await send({ type: "brief.read" }); expect(fetchMock).not.toHaveBeenCalled(); close();
  });

  it("binds all reads to the selected brief and stops serving after disconnect", async () => {
    const close = connectCanvas({ popup, origin, channelId, briefId, onStatus, onResult });
    await send(ready); await send({ type: "brief.read" });
    expect(fetchMock).toHaveBeenCalledWith(`/api/canvas-bridge/briefs/${briefId}`, expect.objectContaining({ method: "GET", cache: "no-store" }));
    const assetId = createEntityId(); await send({ type: "asset.read", assetId });
    expect(fetchMock).toHaveBeenLastCalledWith(`/api/canvas-bridge/briefs/${briefId}/assets/${assetId}`, expect.anything());
    await send({ type: "brief.read", briefId: createEntityId() });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    close(); await send({ type: "brief.read" }); expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("expires a previously verified connection without reading additional data", async () => {
    vi.useFakeTimers();
    const close = connectCanvas({ popup, origin, channelId, briefId, onStatus, onResult });
    await send(ready); vi.setSystemTime(Date.now() + 61 * 60 * 1000);
    await send({ type: "brief.read" }); expect(fetchMock).not.toHaveBeenCalled();
    expect(popup.postMessage).toHaveBeenLastCalledWith(expect.objectContaining({ ok: false, error: expect.stringContaining("到期") }), origin); close();
  });
});
