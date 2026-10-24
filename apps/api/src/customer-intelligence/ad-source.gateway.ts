import { Inject, Injectable, UnprocessableEntityException } from "@nestjs/common";
import { authorize, Permission } from "@yummyai/authz";
import type { TenantContext } from "@yummyai/contracts";
import type { ClamAvScanner, Storage } from "@yummyai/storage";
import { PRIVATE_STORAGE } from "../platform.tokens.js";

export const AD_SOURCE_SCANNER = Symbol("AD_SOURCE_SCANNER");
export interface AdSourceScanner {
  scan(input: {
    body: Uint8Array;
    fileName: string;
    mediaType: string;
  }): ReturnType<ClamAvScanner["scan"]>;
}
@Injectable()
export class AdSourceGateway {
  constructor(
    @Inject(PRIVATE_STORAGE) private readonly storage: Storage,
    @Inject(AD_SOURCE_SCANNER) private readonly scanner: AdSourceScanner,
  ) {}
  async store(context: TenantContext, importId: string, content: string,
    beforeUpload?: () => Promise<TenantContext>) {
    authorize(context, Permission.CustomerIntelligenceWrite);
    const body = Buffer.from(content, "utf8"),
      fileName = `${importId}.csv`,
      mediaType = "text/csv; charset=utf-8";
    let scan;
    try {
      scan = await this.scanner.scan({ body, fileName, mediaType });
    } catch {
      throw new UnprocessableEntityException("广告来源扫描暂不可用，请稍后重试；未导入数据");
    }
    if (scan.result !== "clean" || scan.signatureVersion === "unavailable")
      throw new UnprocessableEntityException("广告来源未通过扫描；未导入数据");
    const uploadContext = beforeUpload ? await beforeUpload() : context;
    if (uploadContext.tenantId !== context.tenantId || uploadContext.userId !== context.userId)
      throw new Error("Advertising upload authority identity mismatch");
    authorize(uploadContext, Permission.CustomerIntelligenceWrite);
    return {
      ...(await this.storage.putPrivate(uploadContext, {
        body,
        domain: "advertising",
        fileName,
        mediaType,
      })),
      scan,
    };
  }
  async discard(context: TenantContext, id: string, objectKey: string) {
    await this.storage.discardAdvertisingSource(context, id, objectKey);
  }
  async read(context: TenantContext, id: string, objectKey: string, checksum: string) {
    const bytes = await this.storage.readPrivate(
      context,
      { id, tenantId: context.tenantId, assetDomain: "advertising", objectKey },
      { requiredDomain: "advertising", maxBytes: 5 * 1024 * 1024 },
    );
    // The raw source is retained byte for byte and checked before it is returned.
    const { createHash } = await import("node:crypto");
    if (createHash("sha256").update(bytes).digest("hex") !== checksum)
      throw new Error("Advertising source checksum mismatch");
    return bytes;
  }
}
