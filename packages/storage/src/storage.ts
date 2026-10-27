import {
  CopyObjectCommand,
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectVersionsCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { TenantContext } from "@yummyai/contracts";
import { authorize, Permission } from "@yummyai/authz";

import {
  assertAssetAccess,
  objectKey,
  type AssetDomain,
  type StoredAsset,
} from "./asset-policy.js";
import { checksumSha256 } from "./checksum.js";
import {assertFactoryReadPermit,type FactoryReadPermit} from "./factory-read-permit.js";

export interface PutPrivateInput {
  body: Uint8Array;
  domain: AssetDomain;
  fileName: string;
  mediaType: string;
}

export interface PutPrivateResult {
  checksumSha256: string;
  deduplicated: boolean;
  objectKey: string;
}

export interface PromotePrivateInput extends StoredAsset {
  checksumSha256: string;
  fileName: string;
  mediaType: string;
}

export class Storage {
  constructor(
    private readonly client: S3Client,
    private readonly bucket: string,
  ) {}

  /** Deployment readiness is a read. Bucket creation remains an explicit setup action. */
  async assertBucketReady(): Promise<void> {
    await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
  }

  async ensureBucket(): Promise<void> {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
    } catch (error) {
      if (!isMissing(error)) throw error;
      await this.client.send(new CreateBucketCommand({ Bucket: this.bucket }));
    }
  }

  async putPrivate(context: TenantContext, input: PutPrivateInput): Promise<PutPrivateResult> {
    const checksum = checksumSha256(input.body);
    const key = objectKey({
      tenantId: context.tenantId,
      domain: input.domain,
      sha256: checksum,
      fileName: input.fileName,
    });

    try {
      await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return { checksumSha256: checksum, deduplicated: true, objectKey: key };
    } catch (error) {
      if (!isMissing(error)) throw error;
    }

    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: input.body,
        ContentType: input.mediaType,
        Metadata: {
          "asset-domain": input.domain,
          "sha256": checksum,
          "tenant-id": context.tenantId,
        },
      }),
    );
    return { checksumSha256: checksum, deduplicated: false, objectKey: key };
  }

  /** Discard only an uncommitted, encrypted order-design response. Callers must
   * first verify that the database does not reference this exact object. */
  async discardOrderDesignResponse(context: TenantContext, requestId: string, key: string): Promise<void> {
    assertAssetAccess(context, { id: requestId, tenantId: context.tenantId, assetDomain: "order", objectKey: key }, "order");
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(requestId)
      || key.split("/").length !== 5 || !/^[a-f0-9]{64}$/.test(key.split("/")[3] ?? "")
      || key.split("/")[4] !== `${requestId}-response-quarantine.pe`)
      throw new Error("Only an order-design response quarantine can be discarded");
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  /** Only a fresh, unregistered work upload. The owner holds its work lock and
   * checks for committed references before every exact object-version delete. */
  async discardOrderWorkUpload(context: TenantContext, imageId: string, key: string,
    options: { assertCurrent: () => Promise<void> }): Promise<void> {
    assertAssetAccess(context, { id: imageId, tenantId: context.tenantId, assetDomain: "order", objectKey: key }, "order");
    const parts = key.split("/");
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(imageId)
      || parts.length !== 5 || !/^[a-f0-9]{64}$/.test(parts[3] ?? "")
      || ![`${imageId}.pe`, `${imageId}-preview.pe`].includes(parts[4] ?? "")
      || key !== objectKey({ tenantId: context.tenantId, domain: "order", sha256: parts[3]!, fileName: parts[4]! })
      || typeof options?.assertCurrent !== "function") throw new Error("ORDER_WORK_UPLOAD_ARTIFACT_INVALID");
    await options.assertCurrent();
    try { await this.discardCreativeAdoptionKey(key, options); }
    catch { throw new Error("ORDER_WORK_UPLOAD_CLEANUP_UNCONFIRMED"); }
  }

  async discardLogisticsLabel(context: TenantContext, taskId: string, key: string): Promise<void> {
    assertAssetAccess(context,{id:taskId,tenantId:context.tenantId,assetDomain:"order",objectKey:key},"order");
    if(!/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(taskId)||key.split("/").length!==5||!/^[a-f0-9]{64}$/.test(key.split("/")[3]??"")||!new RegExp(`^${taskId}-label-\\d+\\.pdf$`).test(key.split("/")[4]??""))throw new Error("Only an exact private logistics label can be discarded");
    await this.client.send(new DeleteObjectCommand({Bucket:this.bucket,Key:key}));
  }

  /** Caller holds the original execution lock and checked that an output has no
   * committed asset reference. Names are reserved for POD recovery objects. */
  async discardPodExecutionArtifact(context: TenantContext, taskId: string, key: string, kind: "response" | "output"): Promise<void> {
    const domain = kind === "response" ? "quarantine" : "authorized";
    assertAssetAccess(context, { id: taskId, tenantId: context.tenantId, assetDomain: domain, objectKey: key }, domain);
    const parts = key.split("/");
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(taskId)
      || parts.length !== 5 || !/^[a-f0-9]{64}$/.test(parts[3] ?? "")
      || (kind === "response" ? parts[4] !== `${taskId}-pod-response.pe` : !new RegExp(`^${taskId}-pod-output-\\d{1,3}\\.(png|jpg|webp|tiff|svg|mp4|webm|zip|ps|txt|json|bin)$`).test(parts[4] ?? "")))
      throw new Error("Only an exact private POD execution artifact can be discarded");
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  /** The adoption owner holds its database lock and proves that this cancelled
   * request has no committed asset reference. This never removes a prefix or a
   * neighbouring artifact, and completion means all versions are absent. */
  async discardCreativeResponseAdoptionArtifact(context: TenantContext, adoptionId: string, key: string,
    options: { signal?: AbortSignal } = {}): Promise<void> {
    assertAssetAccess(context, { id: adoptionId, tenantId: context.tenantId, assetDomain: "authorized", objectKey: key }, "authorized");
    const parts = key.split("/");
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(adoptionId)
      || parts.length !== 5 || !/^[a-f0-9]{64}$/.test(parts[3] ?? "")
      || !new RegExp(`^${adoptionId}-pod-output-0\\.(png|jpg|webp|tiff)$`).test(parts[4] ?? "")
      || key !== objectKey({ tenantId: context.tenantId, domain: "authorized", sha256: parts[3]!, fileName: parts[4]! }))
      throw new Error("CREATIVE_RESPONSE_ADOPTION_ARTIFACT_INVALID");
    return this.discardCreativeAdoptionKey(key, options);
  }

  /** Multiple files still have exact adoption-owned identities. The caller must
   * recheck its current authority and absence of a registered asset per delete. */
  async discardCreativeOwnerResponseAdoptionArtifact(context: TenantContext, adoptionId: string, key: string,
    options: { signal?: AbortSignal; assertCurrent: () => Promise<void> }): Promise<void> {
    assertAssetAccess(context, { id: adoptionId, tenantId: context.tenantId, assetDomain: "authorized", objectKey: key }, "authorized");
    const parts = key.split("/");
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(adoptionId)
      || parts.length !== 5 || !/^[a-f0-9]{64}$/.test(parts[3] ?? "")
      || !new RegExp(`^${adoptionId}-owner-[0-7]\\.(png|jpg|webp|tiff|json)$`).test(parts[4] ?? "")
      || key !== objectKey({ tenantId: context.tenantId, domain: "authorized", sha256: parts[3]!, fileName: parts[4]! })
      || typeof options.assertCurrent !== "function") throw new Error("CREATIVE_RESPONSE_ADOPTION_ARTIFACT_INVALID");
    await options.assertCurrent();
    return this.discardCreativeAdoptionKey(key, options);
  }

  private async discardCreativeAdoptionKey(key: string, options: { signal?: AbortSignal; assertCurrent?: () => Promise<void> }): Promise<void> {
    const signal = options.signal;
    let verifying = false;
    try {
      assertCreativeAdoptionCleanupActive(signal);
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }), { abortSignal: signal });
      assertCreativeAdoptionCleanupActive(signal);
      // Complete the bounded inventory before making any destructive request.
      const versions = await this.creativeResponseAdoptionVersions(key, signal);
      if (versions.length) {
        // Retain delete markers until all known data versions have been removed.
        for (const version of [...versions.filter(value => !value.marker), ...versions.filter(value => value.marker)]) {
          assertCreativeAdoptionCleanupActive(signal);
          await options.assertCurrent?.();
          await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key, VersionId: version.id }), { abortSignal: signal });
          assertCreativeAdoptionCleanupActive(signal);
        }
      } else {
        let unversioned = false;
        try {
          const head = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }), { abortSignal: signal });
          assertCreativeAdoptionCleanupActive(signal);
          // A newly appeared version must not be hidden by an unversioned delete.
          if (head.VersionId !== undefined || head.DeleteMarker === true) throw new Error("Unexpected object version");
          unversioned = true;
        } catch (error) {
          assertCreativeAdoptionCleanupActive(signal);
          if (!isCreativeAdoptionObjectMissing(error)) throw error;
        }
        if (unversioned) {
          assertCreativeAdoptionCleanupActive(signal);
          await options.assertCurrent?.();
          await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }), { abortSignal: signal });
          assertCreativeAdoptionCleanupActive(signal);
        }
      }

      verifying = true;
      if ((await this.creativeResponseAdoptionVersions(key, signal)).length) throw new Error("Artifact versions remain");
      assertCreativeAdoptionCleanupActive(signal);
      let absent = false;
      try {
        await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }), { abortSignal: signal });
      } catch (error) {
        assertCreativeAdoptionCleanupActive(signal);
        if (!isCreativeAdoptionObjectMissing(error)) throw error;
        absent = true;
      }
      assertCreativeAdoptionCleanupActive(signal);
      if (!absent) throw new Error("Artifact absence is unconfirmed");
      // NoSuchBucket is not proof that this individual object was cleaned up.
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }), { abortSignal: signal });
      assertCreativeAdoptionCleanupActive(signal);
    } catch {
      assertCreativeAdoptionCleanupActive(signal);
      throw new Error(verifying ? "CREATIVE_RESPONSE_ADOPTION_ARTIFACT_ABSENCE_UNCONFIRMED" : "CREATIVE_RESPONSE_ADOPTION_ARTIFACT_CLEANUP_FAILED");
    }
  }

  private async creativeResponseAdoptionVersions(key: string, signal?: AbortSignal): Promise<Array<{ id: string; marker: boolean }>> {
    const versions: Array<{ id: string; marker: boolean }> = [], identities = new Set<string>(), positions = new Set<string>();
    let keyMarker: string | undefined, versionMarker: string | undefined, entries = 0;
    // Both inventories are bounded independently: at most 10 pages/1,000
    // listed entries each, and at most 1,000 exact version deletions overall.
    for (let page = 0; page < 10; page++) {
      assertCreativeAdoptionCleanupActive(signal);
      const response = await this.client.send(new ListObjectVersionsCommand({ Bucket: this.bucket, Prefix: key, MaxKeys: 100,
        ...(keyMarker === undefined ? {} : { KeyMarker: keyMarker }),
        ...(versionMarker === undefined ? {} : { VersionIdMarker: versionMarker }),
      }), { abortSignal: signal });
      assertCreativeAdoptionCleanupActive(signal);
      if (typeof response.IsTruncated !== "boolean" || response.Name !== undefined && response.Name !== this.bucket
        || response.Prefix !== undefined && response.Prefix !== key || response.CommonPrefixes?.length
        || response.CommonPrefixes !== undefined && !Array.isArray(response.CommonPrefixes)
        || response.Versions !== undefined && !Array.isArray(response.Versions)
        || response.DeleteMarkers !== undefined && !Array.isArray(response.DeleteMarkers)) throw new Error("Invalid version inventory");
      const listed = [...(response.Versions ?? []).map(value => ({ ...value, marker: false })),
        ...(response.DeleteMarkers ?? []).map(value => ({ ...value, marker: true }))];
      entries += listed.length;
      if (listed.length > 100 || entries > 1_000) throw new Error("Version inventory exceeds its limit");
      for (const version of listed) {
        if (typeof version.Key !== "string" || !version.Key.startsWith(key)) throw new Error("Invalid listed object key");
        if (version.Key !== key) continue;
        if (typeof version.VersionId !== "string" || !version.VersionId || version.VersionId.length > 1024
          || identities.has(version.VersionId)) throw new Error("Invalid listed object version");
        identities.add(version.VersionId);
        versions.push({ id: version.VersionId, marker: version.marker });
      }
      if (!response.IsTruncated) return versions;
      const nextKey = response.NextKeyMarker, nextVersion = response.NextVersionIdMarker;
      if (typeof nextKey !== "string" || !nextKey.startsWith(key) || nextKey.length > 1024
        || nextVersion !== undefined && (typeof nextVersion !== "string" || nextVersion.length > 1024)) throw new Error("Invalid version cursor");
      const position = JSON.stringify([nextKey, nextVersion ?? null]);
      if (positions.has(position) || nextKey === keyMarker && nextVersion === versionMarker) throw new Error("Repeated version cursor");
      positions.add(position); keyMarker = nextKey; versionMarker = nextVersion;
    }
    throw new Error("Version inventory exceeds its page limit");
  }

  /** Only for a CSV that the caller verified has no committed database reference. */
  async discardAdvertisingSource(context: TenantContext, importId: string, key: string): Promise<void> {
    authorize(context, Permission.CustomerIntelligenceWrite);
    // Cleanup uses the original upload permission, not a new grant to read CSVs.
    // The owning service must hold this exact upload receipt and prove it unused.
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(importId)
      || key.split("/").length !== 5 || !/^[a-f0-9]{64}$/.test(key.split("/")[3] ?? "")
      || key !== objectKey({ tenantId: context.tenantId, domain: "advertising", sha256: key.split("/")[3]!, fileName: `${importId}.csv` }))
      throw new Error("Only an uncommitted advertising CSV can be discarded");
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  /** Exact receipt compensation only, after the import owner proves no commit
   * references this freshly encrypted upload. Never a general order-file delete. */
  async discardFactoryErpSource(context: TenantContext, importId: string, key: string): Promise<void> {
    authorize(context, Permission.OrderWrite);
    assertAssetAccess(context, { id: importId, tenantId: context.tenantId, assetDomain: "order", objectKey: key }, "order");
    const parts = key.split("/");
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(importId)
      || parts.length !== 5 || !/^[a-f0-9]{64}$/.test(parts[3] ?? "")
      || key !== objectKey({ tenantId: context.tenantId, domain: "order", sha256: parts[3]!, fileName: `${importId}-factory-erp-source.pe` }))
      throw new Error("Only an exact uncommitted factory ERP source can be discarded");
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  async promoteToAuthorized(context: TenantContext, input: PromotePrivateInput): Promise<PutPrivateResult> {
    assertAssetAccess(context, input, "research");
    return this.copyToAuthorized(context, input);
  }

  async promoteQuarantineToAuthorized(context: TenantContext, input: PromotePrivateInput): Promise<PutPrivateResult> {
    assertAssetAccess(context, input, "quarantine");
    return this.copyToDomain(context, input, "authorized");
  }

  async promoteQuarantineToOrder(context: TenantContext, input: PromotePrivateInput): Promise<PutPrivateResult> {
    assertAssetAccess(context, input, "quarantine");
    return this.copyToDomain(context, input, "order");
  }

  private async copyToAuthorized(context: TenantContext, input: PromotePrivateInput): Promise<PutPrivateResult> {
    return this.copyToDomain(context, input, "authorized");
  }

  private async copyToDomain(context: TenantContext, input: PromotePrivateInput, domain: "authorized" | "order"): Promise<PutPrivateResult> {
    const key = objectKey({
      tenantId: context.tenantId,
      domain,
      sha256: input.checksumSha256,
      fileName: input.fileName,
    });
    try {
      await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return { checksumSha256: input.checksumSha256, deduplicated: true, objectKey: key };
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    const encodedSource = `${this.bucket}/${input.objectKey.split("/").map(encodeURIComponent).join("/")}`;
    await this.client.send(new CopyObjectCommand({
      Bucket: this.bucket,
      Key: key,
      CopySource: encodedSource,
      ContentType: input.mediaType,
      MetadataDirective: "REPLACE",
      Metadata: { "asset-domain": domain, "sha256": input.checksumSha256, "tenant-id": context.tenantId },
    }));
    return { checksumSha256: input.checksumSha256, deduplicated: false, objectKey: key };
  }

  async signRead(
    context: TenantContext,
    asset: StoredAsset,
    options: { requiredDomain: AssetDomain; expiresInSeconds?: number },
  ): Promise<string> {
    assertAssetAccess(context, asset, options.requiredDomain);
    const expiresIn = options.expiresInSeconds ?? 600;
    if (!Number.isInteger(expiresIn) || expiresIn < 1 || expiresIn > 600) {
      throw new Error("Signed read URLs must expire between 1 and 600 seconds");
    }

    return getSignedUrl(
      this.client,
      new GetObjectCommand({ Bucket: this.bucket, Key: asset.objectKey }),
      { expiresIn },
    );
  }

  async readPrivate(
    context: TenantContext,
    asset: StoredAsset,
    options: { requiredDomain: AssetDomain; maxBytes?: number; signal?: AbortSignal },
  ): Promise<Uint8Array> {
    assertAssetAccess(context, asset, options.requiredDomain);
    return this.readPrivateBytes(asset,options.maxBytes,options.signal);
  }

  /** Metadata proof for an existing immutable object; this is not a new scan
   * or a full byte hash. The caller must recheck live object rights after I/O. */
  async inspectPrivate(context: TenantContext, asset: StoredAsset, options: { requiredDomain: AssetDomain }) {
    assertAssetAccess(context, asset, options.requiredDomain);
    const result = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: asset.objectKey }),
      { abortSignal: AbortSignal.timeout(15_000) });
    return { byteSize: result.ContentLength ?? null, mediaType: result.ContentType ?? null,
      checksumSha256: result.Metadata?.sha256 ?? null, tenantId: result.Metadata?.["tenant-id"] ?? null,
      assetDomain: result.Metadata?.["asset-domain"] ?? null };
  }

  async readFactoryAssignedPrivate(context:TenantContext,asset:StoredAsset,permit:FactoryReadPermit):Promise<Uint8Array>{
    const maxBytes=await assertFactoryReadPermit(context,asset,permit);
    const bytes=await this.readPrivateBytes(asset,maxBytes);
    try{await assertFactoryReadPermit(context,asset,permit);return bytes;}catch(error){bytes.fill(0);throw error;}
  }

  private async readPrivateBytes(asset:StoredAsset,maxBytes?:number,signal?:AbortSignal):Promise<Uint8Array>{
    signal?.throwIfAborted();
    const response = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: asset.objectKey }), signal ? { abortSignal: signal } : undefined);
    if (!response.Body) throw new Error("Private asset body is unavailable");
    if (maxBytes !== undefined || signal) {
      if (maxBytes !== undefined && (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || (response.ContentLength ?? 0) > maxBytes)) {
        await response.Body.transformToWebStream().cancel();
        throw new Error("Private asset exceeds the byte limit");
      }
      const chunks: Uint8Array[] = [];
      let size = 0;
      const reader = response.Body.transformToWebStream().getReader();
      const cancel = () => { void reader.cancel().catch(() => undefined); };
      signal?.addEventListener("abort", cancel, { once: true });
      try {
        for (;;) {
          signal?.throwIfAborted();
          const next = await reader.read();
          signal?.throwIfAborted();
          if (next.done) break;
          size += next.value.byteLength;
          if (maxBytes !== undefined && size > maxBytes) throw new Error("Private asset exceeds the byte limit");
          chunks.push(next.value);
        }
        return Uint8Array.from(Buffer.concat(chunks));
      } finally {
        signal?.removeEventListener("abort", cancel);
        await reader.cancel().catch(() => undefined);
        reader.releaseLock();
      }
    }
    return Uint8Array.from(await response.Body.transformToByteArray());
  }
}

export function createStorageFromEnvironment(): Storage {
  const endpoint = required("S3_ENDPOINT");
  const client = new S3Client({
    endpoint,
    forcePathStyle: true,
    region: process.env.S3_REGION ?? "us-east-1",
    credentials: {
      accessKeyId: required("S3_ACCESS_KEY_ID"),
      secretAccessKey: required("S3_SECRET_ACCESS_KEY"),
    },
  });
  return new Storage(client, required("S3_PRIVATE_BUCKET"));
}

function isMissing(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { name?: string; $metadata?: { httpStatusCode?: number } };
  return candidate.name === "NotFound" || candidate.name === "NoSuchKey" || candidate.$metadata?.httpStatusCode === 404;
}

function assertCreativeAdoptionCleanupActive(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error("CREATIVE_RESPONSE_ADOPTION_ARTIFACT_CLEANUP_ABORTED");
}

function isCreativeAdoptionObjectMissing(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { name?: unknown; $metadata?: { httpStatusCode?: unknown } };
  return candidate.$metadata?.httpStatusCode === 404 && (candidate.name === "NotFound" || candidate.name === "NoSuchKey");
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}
