import {
  DeleteObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectVersionsCommand,
  S3Client,
} from "@aws-sdk/client-s3";

/** Structural boundary for a ticket returned by the database retention owner. */
export interface FactoryErpSourcePurgeTicket {
  tenantId: string;
  importId: string;
  objectKey: string;
  storedChecksum: string;
  leaseToken: string;
  leaseExpiresAt: string;
  attempts: number;
}
export interface FactoryErpSourcePurgeResult {
  verifiedAbsent: true;
  deletedVersions: number;
}
export type FactoryErpSourcePurgeCode = "storage_delete_failed" | "absence_unconfirmed";
export class FactoryErpSourcePurgeError extends Error {
  constructor(readonly code: FactoryErpSourcePurgeCode) {
    super(code);
    this.name = "FactoryErpSourcePurgeError";
  }
}

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const PAGE_SIZE = 100;
const MAX_PAGES = 10;
const MAX_ENTRIES = PAGE_SIZE * MAX_PAGES;
function failed(code: FactoryErpSourcePurgeCode = "storage_delete_failed"): never {
  throw new FactoryErpSourcePurgeError(code);
}

function assertTicket(ticket: FactoryErpSourcePurgeTicket) {
  if (!UUID.test(ticket.tenantId) || !UUID.test(ticket.importId) || !UUID.test(ticket.leaseToken) ||
      !/^[a-f0-9]{64}$/.test(ticket.storedChecksum) || !Number.isSafeInteger(ticket.attempts) || ticket.attempts < 1 ||
      !Number.isFinite(Date.parse(ticket.leaseExpiresAt)) ||
      ticket.objectKey !== `tenants/${ticket.tenantId}/order/${ticket.storedChecksum}/${ticket.importId}-factory-erp-source.pe`) failed();
  // Lease validity belongs to the database clock, including controlled clock
  // tests. Local wall time must never establish or reject a database lease.
}

/** Permanently removes one expired source, including all versions and markers.
 * It cannot create buckets, read source contents, or delete an adjacent key. */
export class FactoryErpSourcePurger {
  constructor(private readonly client: S3Client, private readonly bucket: string) {
    if (!bucket || bucket.trim() !== bucket) failed();
  }

  async purge(ticket: FactoryErpSourcePurgeTicket,
    options: { signal?: AbortSignal } = {}): Promise<FactoryErpSourcePurgeResult> {
    assertTicket(ticket);
    const signal = options.signal;
    let verifying = false;
    try {
      this.assertActive(signal);
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }), { abortSignal: signal });
      const versions = await this.versions(ticket.objectKey, signal);
      let deletedVersions = 0;
      // Keep delete markers in place until all data versions have been removed.
      for (const version of [...versions.filter(v => !v.marker), ...versions.filter(v => v.marker)]) {
        this.assertActive(signal);
        await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket,
          Key: ticket.objectKey, VersionId: version.id }), { abortSignal: signal });
        deletedVersions++;
      }
      verifying = true;
      this.assertActive(signal);
      if ((await this.versions(ticket.objectKey, signal)).length) failed("absence_unconfirmed");
      let absent = false;
      try {
        await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: ticket.objectKey }), { abortSignal: signal });
      } catch (error) {
        const value = error as { name?: unknown; $metadata?: { httpStatusCode?: unknown } } | null;
        absent = value?.$metadata?.httpStatusCode === 404 && (value.name === "NotFound" || value.name === "NoSuchKey");
        if (!absent) failed("absence_unconfirmed");
      }
      if (!absent) failed("absence_unconfirmed");
      this.assertActive(signal);
      // A missing bucket is not proof that an individual source was purged.
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }), { abortSignal: signal });
      return { verifiedAbsent: true, deletedVersions };
    } catch (error) {
      if (error instanceof FactoryErpSourcePurgeError) throw error;
      failed(verifying ? "absence_unconfirmed" : "storage_delete_failed");
    }
  }

  close() { this.client.destroy(); }

  private assertActive(signal?: AbortSignal) { if (signal?.aborted) failed(); }

  private async versions(key: string, signal?: AbortSignal) {
    const versions: Array<{ id: string; marker: boolean }> = [];
    const identities = new Set<string>(), positions = new Set<string>();
    let keyMarker: string | undefined, versionMarker: string | undefined, entries = 0;
    for (let page = 0; page < MAX_PAGES; page++) {
      this.assertActive(signal);
      const response = await this.client.send(new ListObjectVersionsCommand({ Bucket: this.bucket,
        Prefix: key, MaxKeys: PAGE_SIZE,
        ...(keyMarker === undefined ? {} : { KeyMarker: keyMarker }),
        ...(versionMarker === undefined ? {} : { VersionIdMarker: versionMarker }),
      }), { abortSignal: signal });
      if (typeof response.IsTruncated !== "boolean" || response.Name !== undefined && response.Name !== this.bucket ||
          response.Prefix !== undefined && response.Prefix !== key) failed();
      const listed = [...(response.Versions ?? []).map(value => ({ ...value, marker: false })),
        ...(response.DeleteMarkers ?? []).map(value => ({ ...value, marker: true }))];
      entries += listed.length;
      if (listed.length > PAGE_SIZE || entries > MAX_ENTRIES || response.CommonPrefixes?.length) failed();
      for (const item of listed) {
        if (typeof item.Key !== "string") failed();
        if (item.Key !== key) continue;
        if (typeof item.VersionId !== "string" || !item.VersionId || item.VersionId.length > 1024) failed();
        const identity = item.VersionId;
        if (identities.has(identity)) failed();
        identities.add(identity);
        versions.push({ id: item.VersionId, marker: item.marker });
      }
      if (response.IsTruncated !== true) return versions;
      const nextKey = response.NextKeyMarker, nextVersion = response.NextVersionIdMarker;
      if (typeof nextKey !== "string" || !nextKey || nextKey.length > 1024 ||
          nextVersion !== undefined && (typeof nextVersion !== "string" || nextVersion.length > 1024)) failed();
      const position = JSON.stringify([nextKey, nextVersion ?? null]);
      if (positions.has(position) || nextKey === keyMarker && nextVersion === versionMarker) failed();
      positions.add(position); keyMarker = nextKey; versionMarker = nextVersion;
    }
    failed();
  }
}

/** Creates an independent maintenance client, owned and closed by its caller. */
export function createFactoryErpSourcePurgerFromEnvironment(environment: Readonly<NodeJS.ProcessEnv> = process.env) {
  const required = (name: string) => {
    const value = environment[name];
    if (!value) failed();
    return value;
  };
  const bucket = required("S3_PRIVATE_BUCKET"), endpoint = required("S3_ENDPOINT"),
    accessKeyId = required("S3_ACCESS_KEY_ID"), secretAccessKey = required("S3_SECRET_ACCESS_KEY");
  return new FactoryErpSourcePurger(new S3Client({ endpoint, forcePathStyle: true,
    region: environment.S3_REGION ?? "us-east-1", maxAttempts: 1,
    credentials: { accessKeyId, secretAccessKey },
  }), bucket);
}
