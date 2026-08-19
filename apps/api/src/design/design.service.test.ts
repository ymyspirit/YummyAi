import { ConflictException } from "@nestjs/common";
import { createEntityId, type ReviewDesignVersionInput, type RightsSource, type TenantContext, type UploadDesignVersionInput } from "@yummyai/contracts";
import { describe, expect, it } from "vitest";

import {
  AuthorizedDesignAssetRequiredError,
  DesignService,
  ResearchAssetPromotionError,
  RightsApprovalRequiredError,
  type DesignAssetRecord,
  type DesignRepository,
  type DesignTaskRecord,
  type DesignVersionRecord,
} from "./design.service.js";

const context: TenantContext = { tenantId: createEntityId(), userId: createEntityId(), permissions: [], dataScope: "tenant" };

describe("design service", () => {
  it("creates a new version instead of overwriting an approved design", async () => {
    const repository = new MemoryDesignRepository();
    const service = new DesignService(repository);
    const approved = repository.seedApprovedVersion();
    const originalSha = approved.files[0]!.asset.sha256;

    const next = await service.uploadVersion(context, approved.taskId, { files: [{ assetId: repository.authorized.id, role: "production" }] });

    expect(next.id).not.toBe(approved.id);
    expect(repository.versions.find((version) => version.id === approved.id)?.files[0]?.asset.sha256).toBe(originalSha);
    expect(next.status).toBe("pending_review");
  });

  it("blocks unapproved and research-domain files from design versions", async () => {
    const repository = new MemoryDesignRepository();
    const service = new DesignService(repository);
    repository.authorized.rightsApprovedAt = undefined;
    await expect(service.uploadVersion(context, repository.task.id, { files: [{ assetId: repository.authorized.id, role: "effect" }] }))
      .rejects.toBeInstanceOf(AuthorizedDesignAssetRequiredError);
  });

  it("requires rights approval and permanently blocks competitor promotion", async () => {
    const repository = new MemoryDesignRepository();
    const service = new DesignService(repository);
    await expect(service.promoteAsset(context, repository.research.id)).rejects.toBeInstanceOf(RightsApprovalRequiredError);
    await service.approveAssetRights(context, repository.research.id, { kind: "competitor", reference: "competitor listing" });
    await expect(service.promoteAsset(context, repository.research.id)).rejects.toBeInstanceOf(ResearchAssetPromotionError);
  });

  it("requires a rejection reason and only selects approved primaries", async () => {
    const repository = new MemoryDesignRepository();
    const service = new DesignService(repository);
    const version = await service.uploadVersion(context, repository.task.id, { files: [{ assetId: repository.authorized.id, role: "effect" }] });
    await expect(service.reviewVersion(context, version.id, { decision: "reject" } as ReviewDesignVersionInput)).rejects.toThrow();
    await expect(service.setPrimaryVersion(context, repository.task.id, version.id)).rejects.toBeInstanceOf(ConflictException);
    await service.reviewVersion(context, version.id, { decision: "approve" });
    await expect(service.setPrimaryVersion(context, repository.task.id, version.id)).resolves.toMatchObject({ primaryVersionId: version.id, status: "approved" });
  });

  it("returns signed access only for attached authorized files", async () => {
    const repository = new MemoryDesignRepository();
    const service = new DesignService(repository);
    const version = await service.uploadVersion(context, repository.task.id, { files: [{ assetId: repository.authorized.id, role: "source" }] });
    await expect(service.signVersionFile(context, version.id, version.files[0]!.id)).resolves.toMatchObject({ url: "https://signed.example/file", expiresInSeconds: 600 });
  });

  it("allows reviewed order-private render results only with customer-provided rights", async () => {
    const repository = new MemoryDesignRepository();
    const service = new DesignService(repository);
    const version = await repository.createVersion(context, repository.task.id, {
      files: [{ assetId: repository.order.id, role: "effect" }],
    });

    await expect(service.reviewVersion(context, version.id, { decision: "approve" })).resolves.toMatchObject({ status: "approved" });
    await expect(service.signVersionFile(context, version.id, version.files[0]!.id)).resolves.toMatchObject({ url: "https://signed.example/file" });

    const invalid = await repository.createVersion(context, repository.task.id, {
      files: [{ assetId: repository.order.id, role: "effect" }],
    });
    repository.order.rightsSource = { kind: "owned", reference: "invalid order evidence" };
    await expect(service.reviewVersion(context, invalid.id, { decision: "approve" }))
      .rejects.toBeInstanceOf(AuthorizedDesignAssetRequiredError);
  });
});

class MemoryDesignRepository implements DesignRepository {
  task: DesignTaskRecord = { id: createEntityId(), tenantId: context.tenantId, skuId: createEntityId(), title: "Gift mug", brief: "Create production art", status: "open" };
  authorized: DesignAssetRecord = asset("authorized", { kind: "owned", reference: "internal artwork" });
  research: DesignAssetRecord = asset("research");
  order: DesignAssetRecord = asset("order", { kind: "customer_provided", reference: createEntityId() });
  versions: DesignVersionRecord[] = [];

  seedApprovedVersion() {
    const version = this.makeVersion({ files: [{ assetId: this.authorized.id, role: "effect" }] });
    version.status = "approved";
    this.versions.push(version);
    return version;
  }

  async createTask() { return this.task; }
  async getTask(_context: TenantContext, id: string) { return id === this.task.id ? this.task : undefined; }
  async listTasks() { return [this.task]; }
  async createVersion(_context: TenantContext, taskId: string, input: UploadDesignVersionInput) {
    const version = this.makeVersion(input, taskId);
    this.versions.push(version);
    return version;
  }
  async getVersion(_context: TenantContext, id: string) { return this.versions.find((version) => version.id === id); }
  async listVersions() { return this.versions; }
  async reviewVersion(_context: TenantContext, id: string, input: ReviewDesignVersionInput) {
    const version = this.versions.find((candidate) => candidate.id === id)!;
    version.status = input.decision === "approve" ? "approved" : "rejected";
    version.rejectionReason = input.rejectionReason;
    return version;
  }
  async setPrimaryVersion(_context: TenantContext, _taskId: string, versionId: string) {
    this.task = { ...this.task, primaryVersionId: versionId, status: "approved" };
    return this.task;
  }
  async getAsset(_context: TenantContext, id: string) { return [this.authorized, this.research, this.order].find((item) => item.id === id); }
  async approveAssetRights(_context: TenantContext, id: string, source: RightsSource) {
    const found = (await this.getAsset(context, id))!;
    found.rightsSource = source;
    found.rightsApprovedAt = new Date();
    return found;
  }
  async promoteAsset(_context: TenantContext, source: DesignAssetRecord) { return { ...source, id: createEntityId(), domain: "authorized" as const }; }
  async signAsset() { return "https://signed.example/file"; }
  async promoteApprovedCreativeBindings() { return []; }

  private makeVersion(input: UploadDesignVersionInput, taskId = this.task.id): DesignVersionRecord {
    return {
      id: createEntityId(), tenantId: context.tenantId, taskId, versionNumber: this.versions.length + 1,
      status: "pending_review", changeNote: input.changeNote, createdAt: new Date(),
      files: input.files.map((file) => ({
        id: createEntityId(),
        role: file.role,
        asset: [this.authorized, this.research, this.order].find((candidate) => candidate.id === file.assetId)!,
      })),
    };
  }
}

function asset(domain: "research" | "authorized" | "order", rightsSource?: RightsSource): DesignAssetRecord {
  return {
    id: createEntityId(), tenantId: context.tenantId, domain,
    objectKey: `tenants/${context.tenantId}/${domain}/abc/file.psd`, fileName: "file.psd", mediaType: "image/vnd.adobe.photoshop",
    byteSize: 2048, sha256: "a".repeat(64), version: 1, rightsSource, rightsApprovedAt: rightsSource ? new Date() : undefined,
  };
}
