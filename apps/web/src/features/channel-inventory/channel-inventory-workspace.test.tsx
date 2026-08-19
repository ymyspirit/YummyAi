import { createEntityId } from "@yummyai/contracts";
import type { ChannelInventoryWorkspaceView } from "@yummyai/contracts/channel-inventory";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ChannelInventoryWorkspace } from "./channel-inventory-workspace";

describe("ChannelInventoryWorkspace", () => {
  it("renders explicit empty evidence without fabricating availability", () => {
    const data: ChannelInventoryWorkspaceView = {
      stockItems: [],
      accounts: [],
      snapshots: [],
      policies: [],
      runs: [],
      reconciliations: [],
    };
    const html = renderToStaticMarkup(<ChannelInventoryWorkspace data={data} />);
    expect(html).toContain("还没有渠道库存证据");
    expect(html).not.toContain("渠道可售总量");
  });

  it("renders source conditions and the pinned policy version", () => {
    const stockItemId = createEntityId();
    const accountId = createEntityId();
    const policyId = createEntityId();
    const versionId = createEntityId();
    const runId = createEntityId();
    const snapshotId = createEntityId();
    const data = {
      stockItems: [{ id: stockItemId, code: "SKU-1", name: "Pillow", unit: "each" as const }],
      accounts: [{ id: accountId, displayName: "Etsy US", platform: "etsy" as const }],
      snapshots: [{
        id: snapshotId,
        accountId,
        provider: "etsy" as const,
        scopeKey: "etsy:US",
        providerSnapshotId: "provider-1",
        checkpointSequence: 1,
        checkpointCursor: null,
        observedAt: "2026-07-23T08:00:00.000Z",
        recordedAt: "2026-07-23T08:00:01.000Z",
        checksum: "a".repeat(64),
        lines: [{
          id: createEntityId(),
          stockItemId,
          warehouseId: null,
          locationId: null,
          externalSku: "SKU-1",
          source: "fbm" as const,
          condition: "sellable" as const,
          quantity: 12,
          unit: "each" as const,
        }],
      }],
      policies: [{
        id: policyId,
        stockItemId,
        name: "Etsy allocation",
        currentVersion: 2,
        status: "active" as const,
        version: {
          id: versionId,
          version: 2,
          eligibleSources: ["fbm" as const],
          allowVirtual: false,
          safetyBufferQuantity: 2,
          channels: [{
            accountId,
            platform: "etsy" as const,
            marketplaceId: "US",
            listingId: null,
            priority: 1,
            capQuantity: null,
            bufferQuantity: 0,
          }],
          reasonCode: "TEST",
          checksum: "b".repeat(64),
          createdAt: "2026-07-23T08:00:02.000Z",
        },
      }],
      runs: [{
        id: runId,
        policyId,
        policyVersionId: versionId,
        policyVersion: 2,
        stockItemId,
        eligibleQuantity: 12,
        allocatableQuantity: 10,
        allocatedQuantity: 10,
        unit: "each" as const,
        inputChecksum: "c".repeat(64),
        calculatedAt: "2026-07-23T08:00:03.000Z",
        projections: [{
          id: createEntityId(),
          runId,
          stockItemId,
          accountId,
          platform: "etsy" as const,
          marketplaceId: "US",
          listingId: null,
          priority: 1,
          capQuantity: null,
          bufferQuantity: 0,
          allocatedQuantity: 10,
          unit: "each" as const,
          sourceTrace: [{ snapshotId, source: "fbm" as const, condition: "sellable" as const, quantity: 12 }],
          calculatedAt: "2026-07-23T08:00:03.000Z",
        }],
      }],
      reconciliations: [],
    } satisfies ChannelInventoryWorkspaceView;
    const html = renderToStaticMarkup(<ChannelInventoryWorkspace data={data} />);
    expect(html).toContain("商家履约 FBM");
    expect(html).toContain("V2");
    expect(html).toContain("Etsy US");
  });
});
