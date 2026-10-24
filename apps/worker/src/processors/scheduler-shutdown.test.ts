import type { DatabaseConnection } from "@yummyai/database";
import type { Queue } from "bullmq";
import { describe, expect, it, vi } from "vitest";

import { CaptureMediaScheduler } from "./capture-media.processor.js";
import { KnowledgeMaintenanceScheduler } from "./knowledge-maintenance.processor.js";

describe.each([
  ["capture media", (database: DatabaseConnection, queue: Queue) => new CaptureMediaScheduler(database, queue)],
  ["knowledge maintenance", (database: DatabaseConnection, queue: Queue) => new KnowledgeMaintenanceScheduler(database, queue)],
] as const)("%s shutdown", (_name, create) => {
  it("waits for an active dispatch before closing its queue and rejects new dispatches", async () => {
    let finish!: (tenants: []) => void;
    const from = vi.fn(() => new Promise<[]>(resolve => { finish = resolve; }));
    const database = { db: { select: () => ({ from }) } } as unknown as DatabaseConnection;
    const close = vi.fn(async () => undefined);
    const scheduler = create(database, { close } as unknown as Queue);
    const pending = scheduler.dispatch();
    const stopping = scheduler.close();
    await scheduler.dispatch();
    expect(from).toHaveBeenCalledOnce();
    expect(close).not.toHaveBeenCalled();
    finish([]);
    await Promise.all([pending, stopping]);
    expect(close).toHaveBeenCalledOnce();
    await scheduler.dispatch();
    expect(from).toHaveBeenCalledOnce();
  });

  it("closes its queue when the active dispatch fails", async () => {
    let fail!: (error: Error) => void;
    const from = vi.fn(() => new Promise<never>((_resolve, reject) => { fail = reject; }));
    const database = { db: { select: () => ({ from }) } } as unknown as DatabaseConnection;
    const close = vi.fn(async () => undefined);
    const scheduler = create(database, { close } as unknown as Queue);
    const pending = scheduler.dispatch(), stopping = scheduler.close();
    const settled = Promise.allSettled([pending, stopping]);
    fail(new Error("synthetic dispatch failure"));
    expect((await settled).every(result => result.status === "rejected")).toBe(true);
    expect(close).toHaveBeenCalledOnce();
  });
});
