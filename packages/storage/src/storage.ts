import {
  CopyObjectCommand,
  CreateBucketCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { TenantContext } from "@yummyai/contracts";

import {
  assertAssetAccess,
  objectKey,
  type AssetDomain,
  type StoredAsset,
} from "./asset-policy.js";
import { checksumSha256 } from "./checksum.js";

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
    options: { requiredDomain: AssetDomain },
  ): Promise<Uint8Array> {
    assertAssetAccess(context, asset, options.requiredDomain);
    const response = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: asset.objectKey }));
    if (!response.Body) throw new Error("Private asset body is unavailable");
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
