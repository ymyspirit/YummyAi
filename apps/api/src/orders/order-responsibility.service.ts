import { HttpException, Inject, Injectable } from "@nestjs/common";
import type { TenantContext } from "@yummyai/contracts";
import type { DatabaseConnection } from "@yummyai/database";
import {
  OrderLineResponsibilityCoordinator,
  OrderResponsibilityError,
  OrderTaskInboxReader,
} from "@yummyai/order-core";
import { DATABASE_CONNECTION } from "../platform.tokens.js";
@Injectable()
export class OrderResponsibilityService {
  private readonly coordinator: OrderLineResponsibilityCoordinator;
  private readonly inbox: OrderTaskInboxReader;
  constructor(@Inject(DATABASE_CONNECTION) database: DatabaseConnection) {
    this.coordinator = new OrderLineResponsibilityCoordinator(database);
    this.inbox = new OrderTaskInboxReader(database);
  }
  private async call<T>(action: () => Promise<T>) {
    try {
      return await action();
    } catch (error) {
      if (error instanceof OrderResponsibilityError)
        throw new HttpException({ message: error.message }, error.status);
      throw error;
    }
  }
  get(context: TenantContext, lineId: string, query = "") {
    return this.call(() => this.coordinator.get(context, lineId, query));
  }
  update(context: TenantContext, lineId: string, input: unknown) {
    return this.call(() => this.coordinator.update(context, lineId, input));
  }
  list(context: TenantContext, query: unknown) {
    return this.call(() => this.inbox.list(context, query));
  }
}
