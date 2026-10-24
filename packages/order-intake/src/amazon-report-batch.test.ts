import { createEntityId, type TenantContext } from "@yummyai/contracts";
import { ForbiddenError, Permission } from "@yummyai/authz";
import { describe, expect, it, vi } from "vitest";
import { AmazonReportBatchPendingError, AmazonReportBatchProcessor, type AmazonReportBatchRepository, type ReportProcessingTask } from "./amazon-report-batch.js";
import { AmazonReportProcessingError, shouldRetryAmazonArchive } from "./amazon-report-processing.js";

const context: TenantContext = { tenantId: createEntityId(), userId: createEntityId(), permissions: ["order:write", "order:pii:read"], dataScope: "tenant" };
function task(status = "pending"): ReportProcessingTask {
  return { reportLineId: createEntityId(), requestId: createEntityId(), sourceChecksum: "a".repeat(64), expectedVersionId: null, requestedBy: context.userId, status, attemptCount: 0, updatedAt: new Date() };
}
function repository(tasks: ReportProcessingTask[], importing = false): AmazonReportBatchRepository {
  return { read: vi.fn(async () => ({ exists: true, importing, tasks })), retire: vi.fn(async (_context, current, failed) => { current.status = failed ? "failed" : "superseded"; }) };
}

describe("durable Amazon report attachment processing", () => {
  it("continues independent rows after a permanent failure and never reprocesses completed rows", async () => {
    const tasks = [task(), task(), task("completed"), task()];
    let active = 0, peak = 0;
    const process = vi.fn(async (_context, id: string) => {
      const current = tasks.find((value) => value.reportLineId === id)!;
      active += 1; peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      active -= 1; current.status = current === tasks[1] ? "failed" : "completed";
    });
    const runner = new AmazonReportBatchProcessor(repository(tasks), { process });
    await expect(runner.process(context, createEntityId())).resolves.toMatchObject({ completed: 3, failed: 1 });
    expect(process).toHaveBeenCalledTimes(3); expect(peak).toBe(2);
    await runner.process(context, createEntityId());
    expect(process).toHaveBeenCalledTimes(3);
  });

  it("waits when queued work starts before the import or recovery transaction commits", async () => {
    const process = vi.fn();
    await expect(new AmazonReportBatchProcessor(repository([], true), { process }).process(context, createEntityId())).rejects.toBeInstanceOf(AmazonReportBatchPendingError);
    await expect(new AmazonReportBatchProcessor(repository([]), { process }).process(context, createEntityId(), createEntityId())).rejects.toBeInstanceOf(AmazonReportBatchPendingError);
    expect(process).not.toHaveBeenCalled();
  });

  it("waits for an active lease and resumes an interrupted one with the same pinned request", async () => {
    const current = task("processing");
    const process = vi.fn(async () => { current.status = "completed"; });
    const runner = new AmazonReportBatchProcessor(repository([current]), { process });
    await expect(runner.process(context, createEntityId())).rejects.toBeInstanceOf(AmazonReportBatchPendingError);
    expect(process).not.toHaveBeenCalled();
    current.updatedAt = new Date(Date.now() - 121_000);
    await runner.process(context, createEntityId());
    expect(process).toHaveBeenCalledWith(context, current.reportLineId, null, undefined, current.requestId);
  });

  it("retires changed source tasks without executing or acknowledging a customer review", async () => {
    const current = task();
    const repo = repository([current]);
    const process = vi.fn(async () => { throw new AmazonReportProcessingError("superseded", "version changed"); });
    await new AmazonReportBatchProcessor(repo, { process }).process(context, createEntityId());
    expect(current.status).toBe("superseded");
    expect(repo.retire).toHaveBeenCalledWith(context, current, false);
  });

  it("ends a revoked request without automatic retry while another authorized line can finish", async () => {
    const tasks = [task(), task()], repo = repository(tasks);
    const process = vi.fn(async (_context, id: string) => {
      if (id === tasks[0]!.reportLineId) throw new ForbiddenError(Permission.OrderWrite);
      tasks[1]!.status = "completed";
    });
    await expect(new AmazonReportBatchProcessor(repo, { process }).process(context, createEntityId())).resolves.toMatchObject({ completed: 1, failed: 1 });
    expect(repo.retire).toHaveBeenCalledWith(context, tasks[0], true);
    await new AmazonReportBatchProcessor(repo, { process }).process(context, createEntityId());
    expect(process).toHaveBeenCalledTimes(2);
  });

  it("stops reclaiming after three attempts and leaves a recoverable failure", async () => {
    const current = { ...task("processing"), attemptCount: 3, updatedAt: new Date(Date.now() - 121_000) };
    const process = vi.fn();
    await expect(new AmazonReportBatchProcessor(repository([current]), { process }).process(context, createEntityId())).resolves.toMatchObject({ failed: 1 });
    expect(process).not.toHaveBeenCalled();
  });

  it("does not leak unknown execution errors and still lets other rows finish", async () => {
    const tasks = [task(), task()];
    const process = vi.fn(async (_context, id: string) => {
      if (id === tasks[0]!.reportLineId) throw new Error("private source URL and customer value");
      tasks[1]!.status = "completed";
    });
    await expect(new AmazonReportBatchProcessor(repository(tasks), { process }).process(context, createEntityId())).rejects.toThrow("Amazon report attachment execution unavailable");
    expect(tasks[1]!.status).toBe("completed");
  });

  it("retries only transient downloads and scanner availability, with a bounded budget", () => {
    for (const code of ["download_failed", "download_timeout", "scan_unavailable"]) {
      expect(shouldRetryAmazonArchive(code, 1)).toBe(true);
      expect(shouldRetryAmazonArchive(code, 3)).toBe(false);
    }
    for (const code of ["file_rejected", "archive_invalid", "link_unavailable", "quantity_mismatch", "customization_missing"]) expect(shouldRetryAmazonArchive(code, 1)).toBe(false);
  });
});
