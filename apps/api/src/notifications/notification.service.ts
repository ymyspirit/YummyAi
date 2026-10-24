import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import type { TenantContext } from "@yummyai/contracts";
import {
  notifications,
  recordNotificationInTransaction,
  type DatabaseConnection,
  withTenant,
} from "@yummyai/database";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";

import { DATABASE_CONNECTION, NOTIFICATION_REPOSITORY } from "../platform.tokens.js";

import {
  CreateNotificationSchema,
  NotificationInboxSchema,
  type NotificationInbox,
  type NotificationKind,
} from "@yummyai/contracts/operations/notification";
export { CreateNotificationSchema } from "@yummyai/contracts/operations/notification";
export type { NotificationKind } from "@yummyai/contracts/operations/notification";
export interface NotificationRecord {
  id: string;
  kind: NotificationKind;
  title: string;
  body: string;
  resourceType?: string;
  resourceId?: string;
  metadata: Record<string, unknown>;
  readAt?: string;
  createdAt: string;
}
export interface NotificationRepository {
  inbox(
    context: TenantContext,
    options: { unreadOnly: boolean; limit: number; after?: string },
  ): Promise<NotificationInbox>;
  create(
    context: TenantContext,
    input: z.infer<typeof CreateNotificationSchema>,
  ): Promise<NotificationRecord>;
  list(
    context: TenantContext,
    options: { unreadOnly: boolean; limit: number },
  ): Promise<NotificationRecord[]>;
  markRead(context: TenantContext, id: string): Promise<NotificationRecord | undefined>;
  markAllRead(context: TenantContext): Promise<number>;
}

@Injectable()
export class NotificationService {
  constructor(
    @Inject(NOTIFICATION_REPOSITORY) private readonly repository: NotificationRepository,
  ) {}
  create(context: TenantContext, rawInput: z.input<typeof CreateNotificationSchema>) {
    return this.repository.create(context, CreateNotificationSchema.parse(rawInput));
  }
  list(context: TenantContext, options: { unreadOnly?: boolean; limit?: number } = {}) {
    return this.repository.list(context, {
      unreadOnly: options.unreadOnly ?? false,
      limit: Math.min(Math.max(Number.isFinite(options.limit) ? options.limit! : 30, 1), 100),
    });
  }
  inbox(context: TenantContext, options: { unreadOnly: boolean; limit: number; after?: string }) {
    return this.repository.inbox(context, options);
  }
  async markRead(context: TenantContext, id: string) {
    const notification = await this.repository.markRead(context, z.uuidv7().parse(id));
    if (!notification) throw new NotFoundException("Notification not found");
    return notification;
  }
  markAllRead(context: TenantContext) {
    return this.repository.markAllRead(context);
  }
}

@Injectable()
export class DrizzleNotificationRepository implements NotificationRepository {
  constructor(@Inject(DATABASE_CONNECTION) private readonly database: DatabaseConnection) {}
  async inbox(
    context: TenantContext,
    options: { unreadOnly: boolean; limit: number; after?: string },
  ) {
    return withTenant(this.database.db, context, async (tx) => {
      const own = eq(notifications.userId, context.userId);
      if (options.after) {
        const [cursor] = await tx
          .select({ id: notifications.id })
          .from(notifications)
          .where(and(own, eq(notifications.id, options.after)))
          .limit(1);
        if (!cursor) throw new NotFoundException("Notification cursor not found");
      }
      const filtered = and(own, options.unreadOnly ? isNull(notifications.readAt) : undefined);
      // Keep the original PostgreSQL timestamp precision at the page boundary.
      const boundary = options.after
        ? sql`(${notifications.createdAt}, ${notifications.id}) <
        (select created_at, id from notifications where id=${options.after} and user_id=${context.userId})`
        : undefined;
      const rows = await tx
        .select()
        .from(notifications)
        .where(and(filtered, boundary))
        .orderBy(desc(notifications.createdAt), desc(notifications.id))
        .limit(options.limit + 1);
      const [counts] = await tx
        .select({
          total: sql<number>`count(*) filter (where ${options.unreadOnly ? sql`${notifications.readAt} is null` : sql`true`})::int`,
          unread: sql<number>`count(*) filter (where ${notifications.readAt} is null)::int`,
        })
        .from(notifications)
        .where(own);
      return NotificationInboxSchema.parse({
        items: rows.slice(0, options.limit).map(mapNotification),
        total: counts!.total,
        unread: counts!.unread,
        nextCursor: rows.length > options.limit ? rows[options.limit - 1]!.id : null,
      });
    });
  }
  async create(context: TenantContext, input: z.infer<typeof CreateNotificationSchema>) {
    const row = await withTenant(this.database.db, context, (tx) =>
      recordNotificationInTransaction(tx, context, input),
    );
    return mapNotification(row);
  }
  async list(context: TenantContext, options: { unreadOnly: boolean; limit: number }) {
    const predicate = options.unreadOnly
      ? and(eq(notifications.userId, context.userId), isNull(notifications.readAt))
      : eq(notifications.userId, context.userId);
    const rows = await withTenant(this.database.db, context, (tx) =>
      tx
        .select()
        .from(notifications)
        .where(predicate)
        .orderBy(desc(notifications.createdAt))
        .limit(options.limit),
    );
    return rows.map(mapNotification);
  }
  async markRead(context: TenantContext, id: string) {
    const [row] = await withTenant(this.database.db, context, (tx) =>
      tx
        .update(notifications)
        .set({ readAt: sql`coalesce(${notifications.readAt}, clock_timestamp())` })
        .where(and(eq(notifications.id, id), eq(notifications.userId, context.userId)))
        .returning(),
    );
    return row ? mapNotification(row) : undefined;
  }
  async markAllRead(context: TenantContext) {
    const rows = await withTenant(this.database.db, context, (tx) =>
      tx
        .update(notifications)
        .set({ readAt: new Date() })
        .where(and(eq(notifications.userId, context.userId), isNull(notifications.readAt)))
        .returning({ id: notifications.id }),
    );
    return rows.length;
  }
}

function mapNotification(row: typeof notifications.$inferSelect): NotificationRecord {
  return {
    id: row.id,
    kind: row.kind as NotificationKind,
    title: row.title,
    body: row.body,
    resourceType: row.resourceType ?? undefined,
    resourceId: row.resourceId ?? undefined,
    metadata: row.metadata,
    readAt: row.readAt?.toISOString(),
    createdAt: row.createdAt.toISOString(),
  };
}
