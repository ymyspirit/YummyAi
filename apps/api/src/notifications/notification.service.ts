import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { createEntityId, type TenantContext } from "@yummyai/contracts";
import { notifications, type DatabaseConnection, withTenant } from "@yummyai/database";
import { and, desc, eq, isNull } from "drizzle-orm";
import { z } from "zod";

import { DATABASE_CONNECTION, NOTIFICATION_REPOSITORY } from "../platform.tokens.js";

const NotificationKindSchema = z.enum(["job_completed", "job_failed", "review_requested", "review_decided", "design_overdue", "system"]);
export const CreateNotificationSchema = z.object({ kind: NotificationKindSchema, title: z.string().trim().min(1).max(160), body: z.string().trim().min(1).max(2_000), resourceType: z.string().max(80).optional(), resourceId: z.uuidv7().optional(), metadata: z.record(z.string(), z.unknown()).default({}) });
export type NotificationKind = z.infer<typeof NotificationKindSchema>;
export interface NotificationRecord { id: string; kind: NotificationKind; title: string; body: string; resourceType?: string; resourceId?: string; metadata: Record<string, unknown>; readAt?: string; createdAt: string }
export interface NotificationRepository {
  create(context: TenantContext, input: z.infer<typeof CreateNotificationSchema>): Promise<NotificationRecord>;
  list(context: TenantContext, options: { unreadOnly: boolean; limit: number }): Promise<NotificationRecord[]>;
  markRead(context: TenantContext, id: string): Promise<NotificationRecord | undefined>;
  markAllRead(context: TenantContext): Promise<number>;
}

@Injectable()
export class NotificationService {
  constructor(@Inject(NOTIFICATION_REPOSITORY) private readonly repository: NotificationRepository) {}
  create(context: TenantContext, rawInput: z.input<typeof CreateNotificationSchema>) { return this.repository.create(context, CreateNotificationSchema.parse(rawInput)); }
  list(context: TenantContext, options: { unreadOnly?: boolean; limit?: number } = {}) { return this.repository.list(context, { unreadOnly: options.unreadOnly ?? false, limit: Math.min(Math.max(options.limit ?? 30, 1), 100) }); }
  async markRead(context: TenantContext, id: string) { const notification = await this.repository.markRead(context, z.uuidv7().parse(id)); if (!notification) throw new NotFoundException("Notification not found"); return notification; }
  markAllRead(context: TenantContext) { return this.repository.markAllRead(context); }
}

@Injectable()
export class DrizzleNotificationRepository implements NotificationRepository {
  constructor(@Inject(DATABASE_CONNECTION) private readonly database: DatabaseConnection) {}
  async create(context: TenantContext, input: z.infer<typeof CreateNotificationSchema>) {
    const [row] = await withTenant(this.database.db, context, (tx) => tx.insert(notifications).values({ id: createEntityId(), tenantId: context.tenantId, userId: context.userId, ...input }).returning());
    return mapNotification(row!);
  }
  async list(context: TenantContext, options: { unreadOnly: boolean; limit: number }) {
    const predicate = options.unreadOnly ? and(eq(notifications.userId, context.userId), isNull(notifications.readAt)) : eq(notifications.userId, context.userId);
    const rows = await withTenant(this.database.db, context, (tx) => tx.select().from(notifications).where(predicate).orderBy(desc(notifications.createdAt)).limit(options.limit));
    return rows.map(mapNotification);
  }
  async markRead(context: TenantContext, id: string) {
    const [row] = await withTenant(this.database.db, context, (tx) => tx.update(notifications).set({ readAt: new Date() }).where(and(eq(notifications.id, id), eq(notifications.userId, context.userId))).returning());
    return row ? mapNotification(row) : undefined;
  }
  async markAllRead(context: TenantContext) {
    const rows = await withTenant(this.database.db, context, (tx) => tx.update(notifications).set({ readAt: new Date() }).where(and(eq(notifications.userId, context.userId), isNull(notifications.readAt))).returning({ id: notifications.id }));
    return rows.length;
  }
}

function mapNotification(row: typeof notifications.$inferSelect): NotificationRecord { return { id: row.id, kind: row.kind as NotificationKind, title: row.title, body: row.body, resourceType: row.resourceType ?? undefined, resourceId: row.resourceId ?? undefined, metadata: row.metadata, readAt: row.readAt?.toISOString(), createdAt: row.createdAt.toISOString() }; }
