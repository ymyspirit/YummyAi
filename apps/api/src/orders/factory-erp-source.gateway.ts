import { createHash } from "node:crypto";
import { Inject, Injectable, UnprocessableEntityException } from "@nestjs/common";
import { ForbiddenError, Permission, permissionScope, requireTenantOrderPermissions } from "@yummyai/authz";
import type { SecretVault } from "@yummyai/ai-core";
import type { TenantContext } from "@yummyai/contracts";
import { EntityIdSchema } from "@yummyai/contracts/common/ids";
import { FACTORY_ERP_MAX_BYTES } from "@yummyai/contracts/order/factory-erp-import";
import { objectKey as privateObjectKey } from "@yummyai/storage";
import type { ClamAvScanner, PutPrivateResult, Storage } from "@yummyai/storage";
import { ORDER_PII_VAULT, PRIVATE_STORAGE } from "../platform.tokens.js";

export const FACTORY_ERP_SOURCE_SCANNER = Symbol("FACTORY_ERP_SOURCE_SCANNER");

export interface FactoryErpSourceScanner {
  scan(input: { body: Uint8Array; fileName: string; mediaType: string }): ReturnType<ClamAvScanner["scan"]>;
}

export interface FactoryErpSourceReceipt extends PutPrivateResult {
  scan: Awaited<ReturnType<ClamAvScanner["scan"]>>;
  rawChecksumSha256: string;
  byteSize: number;
}

const MAX_CIPHERTEXT_BYTES = 10 * 1024 * 1024;
const MAX_BASE64_CHARACTERS = 4 * Math.ceil(FACTORY_ERP_MAX_BYTES / 3);
const sha = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");
const readPermissions = [Permission.OrderRead, Permission.OrderPiiRead, Permission.AssetRead] as const;
const writePermissions = [...readPermissions, Permission.OrderWrite] as const;

function requireAccess(context: TenantContext, write: boolean) {
  const permissions = write ? writePermissions : readPermissions;
  requireTenantOrderPermissions(context, permissions);
  for (const permission of permissions) {
    if (permissionScope(context, permission) !== "tenant")
      throw new ForbiddenError(permission, "outside_data_scope");
  }
}

function invalid(code: string): never {
  throw new UnprocessableEntityException({ code, message: "工厂导出原件暂不可用 请保留原文件并重新核对" });
}

function importId(value: string): string {
  if (!EntityIdSchema.safeParse(value).success || value !== value.toLowerCase())
    invalid("factory_erp_source_identity_invalid");
  return value;
}

function sourceName(id: string) { return `${id}-factory-erp-source.pe`; }

function exactPointer(context: TenantContext, id: string, key: string, checksum: string) {
  importId(id);
  if (!/^[a-f0-9]{64}$/.test(checksum) || key !== privateObjectKey({
    tenantId: context.tenantId, domain: "order", sha256: checksum, fileName: sourceName(id),
  })) invalid("factory_erp_source_identity_invalid");
}

@Injectable()
export class FactoryErpSourceGateway {
  constructor(
    @Inject(PRIVATE_STORAGE) private readonly storage: Storage,
    @Inject(ORDER_PII_VAULT) private readonly vault: SecretVault,
    @Inject(FACTORY_ERP_SOURCE_SCANNER) private readonly scanner: FactoryErpSourceScanner,
  ) {}

  async store(
    context: TenantContext,
    id: string,
    fileName: string,
    body: Uint8Array,
    beforeUpload?: () => Promise<TenantContext>,
  ): Promise<FactoryErpSourceReceipt> {
    requireAccess(context, true);
    importId(id);
    if (!body.byteLength || body.byteLength > FACTORY_ERP_MAX_BYTES ||
        fileName.length > 200 || Array.from(fileName).some(char => char.charCodeAt(0) < 32) ||
        !/^[^\\/]+\.(xlsx|csv)$/i.test(fileName))
      invalid("factory_erp_source_invalid");
    const bytes = Buffer.from(body), rawChecksumSha256 = sha(bytes);
    let encrypted: Buffer | undefined;
    try {
      const mediaType = /\.xlsx$/i.test(fileName)
        ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        : "text/csv";
      let scan: FactoryErpSourceReceipt["scan"];
      try {
        scan = await this.scanner.scan({ body: bytes, fileName, mediaType });
      } catch {
        return invalid("factory_erp_source_scan_unavailable");
      }
      if (sha(bytes) !== rawChecksumSha256) invalid("factory_erp_source_changed");
      if (scan.result !== "clean" || !scan.signatureVersion || scan.signatureVersion === "unavailable")
        invalid("factory_erp_source_scan_failed");
      // The callback is owned by the business service and runs in a new short
      // authorization transaction after scanning, never across external I/O.
      const current = beforeUpload ? await beforeUpload() : context;
      if (current.tenantId !== context.tenantId || current.userId !== context.userId)
        invalid("factory_erp_source_authority_changed");
      requireAccess(current, true);
      if (sha(bytes) !== rawChecksumSha256) invalid("factory_erp_source_changed");
      encrypted = Buffer.from(this.vault.encrypt(JSON.stringify({
        version: 1, tenantId: context.tenantId, importId: id,
        checksumSha256: rawChecksumSha256, bodyBase64: bytes.toString("base64"),
      })), "utf8");
      if (encrypted.byteLength > MAX_CIPHERTEXT_BYTES) invalid("factory_erp_source_invalid");
      let stored: PutPrivateResult;
      try {
        stored = await this.storage.putPrivate(current, {
          body: encrypted, domain: "order", fileName: sourceName(id), mediaType: "application/octet-stream",
        });
      } catch {
        return invalid("factory_erp_source_store_failed");
      }
      return { ...stored, scan, rawChecksumSha256, byteSize: bytes.byteLength };
    } finally {
      bytes.fill(0);
      encrypted?.fill(0);
    }
  }

  async read(
    context: TenantContext,
    id: string,
    key: string,
    storedChecksum: string,
    rawChecksum: string,
  ): Promise<Buffer> {
    requireAccess(context, false);
    exactPointer(context, id, key, storedChecksum);
    if (!/^[a-f0-9]{64}$/.test(rawChecksum)) invalid("factory_erp_source_identity_invalid");
    let encrypted: Buffer;
    try {
      const stored = await this.storage.readPrivate(context,
        { id, tenantId: context.tenantId, assetDomain: "order", objectKey: key },
        { requiredDomain: "order", maxBytes: MAX_CIPHERTEXT_BYTES });
      encrypted = Buffer.from(stored);
    } catch {
      return invalid("factory_erp_source_unavailable");
    }
    try {
      if (!encrypted.byteLength || encrypted.byteLength > MAX_CIPHERTEXT_BYTES || sha(encrypted) !== storedChecksum)
        invalid("factory_erp_source_unavailable");
      const cipher = new TextDecoder("utf-8", { fatal: true }).decode(encrypted);
      return this.vault.withSecret(cipher, text => {
        const value: unknown = JSON.parse(text);
        if (!value || typeof value !== "object" || Array.isArray(value))
          invalid("factory_erp_source_unavailable");
        const envelope = value as Record<string, unknown>;
        if (Object.keys(envelope).length !== 5 || envelope.version !== 1 ||
            envelope.tenantId !== context.tenantId || envelope.importId !== id ||
            envelope.checksumSha256 !== rawChecksum || typeof envelope.bodyBase64 !== "string" ||
            !envelope.bodyBase64 || envelope.bodyBase64.length > MAX_BASE64_CHARACTERS ||
            envelope.bodyBase64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(envelope.bodyBase64))
          invalid("factory_erp_source_unavailable");
        const original = Buffer.from(envelope.bodyBase64, "base64");
        if (!original.byteLength || original.byteLength > FACTORY_ERP_MAX_BYTES ||
            original.toString("base64") !== envelope.bodyBase64 || sha(original) !== rawChecksum) {
          original.fill(0);
          invalid("factory_erp_source_unavailable");
        }
        // The service rechecks current membership, source identity and DB pins
        // after this I/O before it uses the returned private bytes.
        return original;
      });
    } catch {
      return invalid("factory_erp_source_unavailable");
    } finally {
      encrypted.fill(0);
    }
  }

  async discard(context: TenantContext, id: string, key: string): Promise<void> {
    // Only the business owner may call this with its exact upload receipt after
    // proving that no committed import references it, including after revocation.
    await this.storage.discardFactoryErpSource(context, importId(id), key);
  }
}
