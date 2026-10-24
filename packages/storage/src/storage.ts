import {
  CopyObjectCommand,
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
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

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}
