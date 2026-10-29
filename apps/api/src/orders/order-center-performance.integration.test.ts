import "reflect-metadata";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import { and, eq, sql } from "drizzle-orm";
import type postgres from "../../../../packages/database/node_modules/postgres/types/index.js";
import * as schema from "../../../../packages/database/src/schema/index.js";
import {
  amazonOrderReportReadModels,
  amazonOrderReportVersions,
  withTenant,
  type DatabaseConnection,
} from "@yummyai/database";
import {
  OrderWorkDraftSchema,
  OrderWorkSummariesSchema,
  type OrderWorkSummary,
} from "@yummyai/contracts/order/workspace";
import { Permission } from "@yummyai/authz";
import JSZip from "jszip";
import sharp from "sharp";
import { requireOrderSummaryEnvironment } from "../../../../tools/testing/require-order-summary-availability-environment.mjs";
import {
  createOrderSummaryFixture,
  type OrderSummaryCase,
} from "./order-summary-availability.test-fixture.js";

// The existing summary config and exact disposable nonce guard are retained.
// Driver hooks observe actual queries and returned values without altering them.
// No SQL parameters, credentials, ciphertext or buyer text enter the proof.
const isolated = requireOrderSummaryEnvironment();
type Metrics = {
  queries: number;
  tenantTransactions: number;
  versionReads: number;
  incomingBytes: number;
  rawPrivateValues: number;
  rawPrivateBytes: number;
};
const freshMetrics = (): Metrics => ({
  queries: 0,
  tenantTransactions: 0,
  versionReads: 0,
  incomingBytes: 0,
  rawPrivateValues: 0,
  rawPrivateBytes: 0,
});
let active: Metrics | null = null;
const rawPrivateColumn = (name: string) =>
  /^encrypted_?(?:source|document|archive|envelope)$/i.test(name);
function observeValue(value: unknown, name: string): void {
  if (!active || value === null || value === undefined) return;
  if (typeof value === "string") {
    const bytes = Buffer.byteLength(value);
    active.incomingBytes += bytes;
    if (rawPrivateColumn(name)) {
      active.rawPrivateValues++;
      active.rawPrivateBytes += bytes;
    }
  } else if (Array.isArray(value)) for (const entry of value) observeValue(entry, name);
  else if (typeof value === "object")
    for (const [key, entry] of Object.entries(value)) observeValue(entry, key);
}
const requireDatabase = createRequire(
  new URL("../../../../packages/database/package.json", import.meta.url),
);
const createPostgres = requireDatabase("postgres") as typeof postgres;
const client = createPostgres(isolated.url, {
  max: 4,
  prepare: false,
  debug: (_connection, query) => {
    if (!active) return;
    active.queries++;
    if (/^\s*set\s+local\s+role\s+yummyai_app\s*$/i.test(query)) active.tenantTransactions++;
    if (
      /^\s*(?:select|with)\b/i.test(query) &&
      /\b(?:from|join)\s+"amazon_order_report_versions"(?:\s|$)/i.test(query)
    )
      active.versionReads++;
  },
  transform: {
    value: {
      from: (value, column) => {
        observeValue(value, column.name);
        return value;
      },
    },
  },
});
const database: DatabaseConnection = { client, db: drizzle(client, { schema }) };
type Fixture = Awaited<ReturnType<typeof createOrderSummaryFixture>>;
let f: Fixture | undefined;
const sources: OrderSummaryCase[] = [];
const proof: Record<string, unknown> = {
  scope: "actual_native_summary_batch_queries_and_wire_values_synthetic_orders",
  nonce: isolated.nonce,
  modelCalls: 0,
  workerProcesses: 0,
  hardwareLatencyThreshold: false,
};
const sha = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
function fixture(): Fixture {
  if (!f) throw new Error("order_center_performance_fixture_missing");
  return f;
}
async function within<T>(value: Promise<T>, code: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      value,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(code)), 30_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function read(values: readonly OrderSummaryCase[]) {
  return OrderWorkSummariesSchema.parse(
    await fixture().work.summaries(await fixture().current(), {
      ids: values.map((value) => value.lineId),
    }),
  ).items;
}
function item(items: readonly OrderWorkSummary[], source: OrderSummaryCase) {
  const matches = items.filter((value) => value.id === source.lineId);
  expect(matches).toHaveLength(1);
  return matches[0]!;
}
function available(summary: OrderWorkSummary, source: OrderSummaryCase) {
  expect(summary.availability).toBe("available");
  expect(summary.sourceVersionId).toBe(source.reportVersionId);
  expect(summary.error).toBeNull();
  expect(summary.instructions).toBe(source.fixtureSentinel);
  expect(summary.fields.some((field) => field.value === source.fixtureSentinel)).toBe(true);
  expect(summary.images.length).toBeGreaterThan(0);
}
function hidden(
  summary: OrderWorkSummary,
  source: OrderSummaryCase,
  state: "failed" | "expired" | "cleared",
) {
  expect(summary.availability).toBe(state);
  expect(summary.error).not.toBeNull();
  expect(summary.sourceVersionId).toBeNull();
  expect(summary.designExecutor).toBeNull();
  expect(summary.fields).toEqual([]);
  expect(summary.images).toEqual([]);
  expect(summary.blockers).toEqual([]);
  expect(summary.instructions).toBe("");
  expect(JSON.stringify(summary)).not.toContain(source.fixtureSentinel);
}

async function retainLargeOriginal(source: OrderSummaryCase) {
  const owner = fixture();
  if (!source.reportLineId || !source.reportVersionId)
    throw new Error("synthetic_large_original_report_required");
  const image = await sharp(randomBytes(512 * 512 * 3), {
    raw: { width: 512, height: 512, channels: 3 },
  })
    .png()
    .toBuffer();
  const archive = new JSZip();
  archive.file(
    "order.json",
    JSON.stringify({
      orderId: source.externalOrderId,
      orderItemId: source.externalLineId,
      customizationData: {
        type: "PageContainerCustomization",
        snapshot: { imageName: "preview.png" },
        children: [
          {
            type: "TextCustomization",
            label: "Synthetic private choice",
            inputValue: source.fixtureSentinel,
          },
          {
            type: "ImageCustomization",
            image: { imageName: "buyer.png", buyerFilename: "synthetic-buyer.png" },
          },
        ],
      },
    }),
  );
  archive.file("preview.png", image);
  archive.file("buyer.png", image);
  const bytes = await archive.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  expect(bytes.length).toBeGreaterThan(1_000_000);
  const context = await owner.current(),
    parsed = await owner.reports.process(
      context,
      source.reportLineId,
      source.reportVersionId,
      bytes,
    );
  if (!parsed.versionId) throw new Error("synthetic_large_original_version_missing");
  const detail = await owner.work.detail(context, source.lineId);
  const saved = await owner.work.save(context, source.lineId, {
    expectedRevision: detail.line.revision,
    expectedProjectionVersion: detail.line.projectionVersion,
    expectedSourceVersionId: parsed.versionId,
    draft: OrderWorkDraftSchema.parse({
      ...detail.draft,
      instructions: source.fixtureSentinel,
      fields: [
        {
          key: "synthetic-choice",
          label: "Synthetic private choice",
          kind: "text",
          value: source.fixtureSentinel,
        },
      ],
      images: parsed.files
        .filter((file) => file.role === "buyer_image")
        .map((file) => ({ origin: "report", key: file.key, usage: "Synthetic buyer image" })),
    }),
    status: "needs_information",
    reason: "Synthetic large retained report for read-only performance acceptance",
    idempotencyKey: randomUUID(),
  });
  source.reportVersionId = parsed.versionId;
  source.revision = saved.line.revision;
  source.projectionVersion = saved.line.projectionVersion;
  const [retained] = await withTenant(database.db, context, (tx) =>
    tx
      .select({ bytes: sql<number>`octet_length(${amazonOrderReportVersions.encryptedArchive})` })
      .from(amazonOrderReportVersions)
      .where(eq(amazonOrderReportVersions.id, parsed.versionId!)),
  );
  expect(Number(retained?.bytes)).toBeGreaterThan(1_000_000);
  return Number(retained!.bytes);
}

async function measure(values: readonly OrderSummaryCase[]) {
  const context = await fixture().current(),
    stats = freshMetrics();
  active = stats;
  try {
    return {
      stats,
      items: OrderWorkSummariesSchema.parse(
        await fixture().work.summaries(context, { ids: values.map((value) => value.lineId) }),
      ).items,
    };
  } finally {
    active = null;
  }
}

describe.sequential(
  "order center summaries batch source reads without weakening private source checks",
  () => {
    beforeAll(async () => {
      f = await createOrderSummaryFixture({ database });
      for (let index = 0; index < 12; index++) sources.push(await f.createCase("healthy_saved"));
      expect(new Set(sources.map((source) => source.orderId)).size).toBe(sources.length);
      proof.retainedLargeArchiveBytes = await retainLargeOriginal(sources[0]!);
    }, 240_000);
    afterAll(async () => {
      active = null;
      const failures: unknown[] = [];
      try {
        const directory = resolve(isolated.lane, "qa");
        await mkdir(directory, { recursive: true });
        await writeFile(
          resolve(directory, `${isolated.nonce}-order-center-performance-proof.json`),
          JSON.stringify(proof, null, 2),
        );
      } catch (error) {
        failures.push(error);
      }
      try {
        if (f) await f.close();
        else await client.end();
      } catch (error) {
        failures.push(error);
      }
      if (failures.length)
        throw new AggregateError(failures, "order_center_performance_cleanup_failed");
    });

    it("keeps source-query and tenant-transaction counts bounded from one to twelve rows and never transfers retained large private bodies", async () => {
      const owner = fixture(),
        beforeFacts = await owner.facts(sources),
        beforeEffects = { ...owner.effects };
      const single = await measure([sources[0]!]),
        batch = await measure(sources);
      expect(single.items).toHaveLength(1);
      expect(batch.items).toHaveLength(12);
      for (const source of sources) available(item(batch.items, source), source);
      available(single.items[0]!, sources[0]!);
      expect(single.stats.tenantTransactions).toBeGreaterThan(0);
      expect(single.stats.versionReads).toBeGreaterThan(0);
      expect(single.stats.incomingBytes).toBeGreaterThan(0);
      expect(batch.stats.tenantTransactions).toBeLessThanOrEqual(
        single.stats.tenantTransactions + 1,
      );
      expect(batch.stats.versionReads).toBeLessThanOrEqual(single.stats.versionReads + 2);
      expect(single.stats.rawPrivateValues).toBe(0);
      expect(batch.stats.rawPrivateValues).toBe(0);
      expect(single.stats.rawPrivateBytes).toBe(0);
      expect(batch.stats.rawPrivateBytes).toBe(0);
      expect(await owner.facts(sources)).toEqual(beforeFacts);
      expect(owner.effects).toEqual(beforeEffects);
      proof.batchRead = {
        single: single.stats,
        twelve: batch.stats,
        unchangedBusinessFactsSha256: sha(beforeFacts),
        exactReturnedSourceVersions: true,
        retainedCiphertextWasNotTransferred: true,
      };
    });

    it("isolates damaged metadata and an expired peer inside the same batch without leaking either private body", async () => {
      const owner = fixture(),
        damaged = sources[1]!,
        // Native retention erases expired work keys. This sacrificial order is
        // never restored or reused as a healthy control in later cases.
        expired = await owner.createCase("healthy_saved"),
        context = await owner.current();
      const batch = [
        ...sources.filter((source) => source !== damaged).slice(0, 10),
        damaged,
        expired,
      ];
      expect(batch).toHaveLength(12);
      expect(new Set(batch.map((source) => source.orderId)).size).toBe(batch.length);
      const [prior] = await withTenant(database.db, context, (tx) =>
        tx
          .select()
          .from(amazonOrderReportReadModels)
          .where(eq(amazonOrderReportReadModels.versionId, damaged.reportVersionId!)),
      );
      if (!prior?.encryptedMetadata)
        throw new Error("synthetic_metadata_corruption_requires_original");
      const originalMetadata = prior.encryptedMetadata,
        broken = "synthetic-invalid-metadata-" + randomUUID();
      const changed = await withTenant(database.db, context, (tx) =>
        tx
          .update(amazonOrderReportReadModels)
          .set({ encryptedMetadata: broken })
          .where(
            and(
              eq(amazonOrderReportReadModels.versionId, damaged.reportVersionId!),
              eq(amazonOrderReportReadModels.encryptedMetadata, originalMetadata),
            ),
          )
          .returning({ id: amazonOrderReportReadModels.versionId }),
      );
      expect(changed).toHaveLength(1);
      try {
        await owner.setWorkExpiry(expired, new Date((await owner.now()).getTime() - 1));
        const values = await read(batch);
        expect(values).toHaveLength(batch.length);
        hidden(item(values, damaged), damaged, "failed");
        hidden(item(values, expired), expired, "expired");
        for (const source of batch.filter((value) => value !== damaged && value !== expired))
          available(item(values, source), source);
      } finally {
        const restored = await withTenant(database.db, context, (tx) =>
          tx
            .update(amazonOrderReportReadModels)
            .set({ encryptedMetadata: originalMetadata })
            .where(
              and(
                eq(amazonOrderReportReadModels.versionId, damaged.reportVersionId!),
                eq(amazonOrderReportReadModels.encryptedMetadata, broken),
              ),
            )
            .returning({ id: amazonOrderReportReadModels.versionId }),
        );
        expect(restored).toHaveLength(1);
      }
      const restored = await read([damaged, expired]);
      available(item(restored, damaged), damaged);
      hidden(item(restored, expired), expired, "expired");
      expect((await owner.facts([expired]))[0]!.work!.hasKey).toBe(false);
      const healthy = await read(sources);
      for (const source of sources) available(item(healthy, source), source);
      proof.mixedDamagedAndExpired = {
        healthyRows: 10,
        damagedIsolated: true,
        expiredHidden: true,
        expiredWorkKeyErasedByOriginalRetention: true,
        metadataCasRestored: true,
        allOriginalControlsStillAvailable: true,
      };
    });

    it("rechecks the original source after a full batch read and discards a cleared row without discarding healthy siblings", async () => {
      const owner = fixture(),
        cleared = sources[3]!,
        held = owner.holdNextSummaryRead(cleared);
      const pending = read(sources).then(
        (value) => ({ value, failure: null }),
        (failure) => ({ value: null, failure }),
      );
      try {
        await within(held.entered, "performance_batch_private_read_not_observed");
        await owner.anonymize(cleared);
        await owner.purge(cleared);
      } finally {
        held.release();
      }
      const result = await within(pending, "performance_batch_late_clear_timeout");
      expect(result.failure).toBeNull();
      if (!result.value) throw new Error("performance_batch_missing_result");
      hidden(item(result.value, cleared), cleared, "cleared");
      for (const source of sources.filter((value) => value !== cleared))
        available(item(result.value, source), source);
      proof.lateClearedBatch = {
        privateRowsDiscarded: 1,
        healthySiblings: 11,
        originalRetentionOwnersUsed: true,
      };
    });

    it("rejects a stale authorized batch when original PII permission is revoked before adoption", async () => {
      const owner = fixture(),
        held = owner.holdNextSummaryRead(sources[0]!),
        context = await owner.current();
      const pending = owner.work
        .summaries(context, { ids: sources.map((source) => source.lineId) })
        .then(
          (value) => ({ value, failure: null }),
          (failure) => ({ value: null, failure }),
        );
      let permissions: Awaited<ReturnType<Fixture["setPiiAccess"]>> | undefined;
      try {
        await within(held.entered, "performance_batch_authority_read_not_observed");
        permissions = await owner.setPiiAccess(false);
        expect(permissions.after.permissions.includes(Permission.OrderPiiRead)).toBe(false);
      } finally {
        held.release();
      }
      try {
        const result = await within(pending, "performance_batch_permission_recheck_timeout");
        expect(result.value).toBeNull();
        expect(result.failure).toMatchObject({ statusCode: 403 });
      } finally {
        await permissions?.restore();
      }
      available(item(await read([sources[0]!]), sources[0]!), sources[0]!);
      expect(owner.effects.modelCalls).toBe(0);
      expect(owner.effects.workerProcesses).toBe(0);
      expect(owner.effects.archiveDownloads).toBe(0);
      proof.latePermissionRevocation = {
        wholePrivateResponseRejected: true,
        noBufferedPrivateResultReturned: true,
        originalPermissionsRestored: true,
      };
    });
  },
);
