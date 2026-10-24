import { expect } from "@playwright/test";
import { Permission } from "../../../packages/authz/src/index";
import { createEntityId, type CaptureDraft, type TenantContext } from "@yummyai/contracts";
import type { CaptureMediaPage } from "@yummyai/contracts/capture/media-preview";
import { connectDatabase, roles, withTenant } from "@yummyai/database";
import { ClamAvScanner, createStorageFromEnvironment } from "@yummyai/storage";
import { QueueName } from "../../../packages/jobs/src/index";
import { eq } from "drizzle-orm";
import { createWorker } from "../../worker/src/main";
import { CaptureMediaDownloader } from "../../worker/src/processors/capture-media.download";
import { CaptureMediaProcessor } from "../../worker/src/processors/capture-media.processor";
import { getApiHeaders } from "../src/server-api";
import { centerApi } from "./order-centers-fixture";

/** Only public DNS/HTTP bytes are controlled. The real downloader policy,
 * authentication, RLS, Redis worker, ClamAV, private S3 and BFF are exercised. */
export async function researchMediaFixture() {
  const url = new URL(process.env.DATABASE_URL ?? "postgres://invalid/invalid");
  const token = /^\/order_daily_e2e_([a-f0-9]{32})$/.exec(url.pathname)?.[1];
  if (
    process.env.E2E_ISOLATED_DAILY !== "1" ||
    !token ||
    process.env.S3_PRIVATE_BUCKET !== `order-daily-e2e-${token}`
  )
    throw new Error("Disposable research media runner required");
  const database = connectDatabase(url.href),
    storage = createStorageFromEnvironment();
  let worker: ReturnType<typeof createWorker> | undefined;
  try {
    const headers = await getApiHeaders();
    const claims = JSON.parse(
      Buffer.from(headers.authorization!.split(".")[1]!, "base64url").toString(),
    ) as { sub: string };
    const [identity] = await database.client.unsafe<{ tenant_id: string; user_id: string }[]>(
      "select m.tenant_id,m.user_id from memberships m join app_users u on u.id=m.user_id where u.oidc_subject=$1 and m.status='active'",
      [claims.sub],
    );
    if (!identity) throw new Error("Synthetic media membership unavailable");
    const context: TenantContext = {
      tenantId: identity.tenant_id,
      userId: identity.user_id,
      permissions: Object.values(Permission),
      dataScope: "tenant",
    };
    const assets = new Map<string, { body: Uint8Array; mediaType: string; status: number }>(),
      reads: string[] = [],
      itemIds = new Set<string>();
    const downloader = new CaptureMediaDownloader({
      resolve: async () => [{ address: "93.184.216.34", family: 4 }],
      read: async (source) => {
        const asset = assets.get(source.href);
        reads.push(source.href);
        if (!asset) throw new Error("Unregistered synthetic media transport");
        return asset;
      },
    });
    const processor = new CaptureMediaProcessor(database, storage, new ClamAvScanner(), downloader);
    async function permissions(values: readonly string[] = Object.values(Permission)) {
      await withTenant(database.db, context, (tx) =>
        tx.update(roles).set({ permissions: values }).where(eq(roles.name, "Fixture operator")),
      );
    }
    return {
      context,
      reads,
      register(sourceUrl: string, body: Uint8Array, mediaType = "image/png", status = 200) {
        assets.set(sourceUrl, { body, mediaType, status });
      },
      media(
        body: Uint8Array,
        kind: "image" | "video" = "image",
        options: { included?: boolean; fail?: boolean; platform?: "amazon" | "etsy" } = {},
      ) {
        const id = createEntityId(),
          mediaType = kind === "video" ? "video/webm" : "image/png";
        const sourceUrl =
          options.platform === "etsy"
            ? `https://i.etsystatic.com/synthetic/${id}.png`
            : `https://m.media-amazon.com/images/I/synthetic-${id}.${kind === "video" ? "webm" : "png"}`;
        assets.set(sourceUrl, { body, mediaType, status: options.fail ? 404 : 200 });
        return { id, sourceUrl, kind, included: options.included ?? true };
      },
      async capture(draft: CaptureDraft) {
        const receipt = await centerApi<{ researchItemId: string; snapshotId: string }>(
          "captures",
          draft,
        );
        itemIds.add(receipt.researchItemId);
        return receipt;
      },
      async startWorker() {
        worker ??= createWorker(QueueName.Media, (envelope) => processor.process(envelope));
        await worker.waitUntilReady();
      },
      async archived(snapshotId: string) {
        await expect
          .poll(
            async () => {
              const page = await centerApi<CaptureMediaPage>(`captures/${snapshotId}/media`);
              return page.counts.queued + page.counts.processing;
            },
            { timeout: 30_000 },
          )
          .toBe(0);
        return centerApi<CaptureMediaPage>(`captures/${snapshotId}/media`);
      },
      permissions,
      async close() {
        try {
          await permissions();
          if (itemIds.size)
            await centerApi("research-items/archive", { itemIds: [...itemIds], archived: true });
        } finally {
          try {
            await worker?.close();
          } finally {
            await database.client.end();
          }
        }
        // The guarded runner deletes and verifies all disposable objects/history.
      },
    };
  } catch (error) {
    await worker?.close();
    await database.client.end();
    throw error;
  }
}
