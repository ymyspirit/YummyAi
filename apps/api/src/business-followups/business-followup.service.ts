import { HttpException, Inject, Injectable } from "@nestjs/common";
import type { TenantContext } from "@yummyai/contracts";
import type { FollowupSource } from "@yummyai/contracts/operations/followup";
import type { DatabaseConnection } from "@yummyai/database";
import { FollowupCoordinator, FollowupError, FollowupInboxReader } from "@yummyai/followup-core";
import { DATABASE_CONNECTION } from "../platform.tokens.js";
@Injectable()
export class BusinessFollowupService {
  private readonly coordinator: FollowupCoordinator;
  private readonly inbox: FollowupInboxReader;
  constructor(@Inject(DATABASE_CONNECTION) database: DatabaseConnection) {
    this.coordinator = new FollowupCoordinator(database);
    this.inbox = new FollowupInboxReader(database);
  }
  private async call<T>(action: () => Promise<T>) {
    try {
      return await action();
    } catch (error) {
      if (error instanceof FollowupError)
        throw new HttpException({ message: error.message }, error.status);
      throw error;
    }
  }
  list(context: TenantContext, source: FollowupSource, query: unknown) {
    return this.call(() => this.inbox.list(context, source, query));
  }
  get(context: TenantContext, source: FollowupSource, id: string, q = "") {
    return this.call(() => this.coordinator.get(context, source, id, q));
  }
  update(
    context: TenantContext,
    source: FollowupSource,
    id: string,
    input: unknown,
    resume = false,
  ) {
    return this.call(() => this.coordinator.update(context, source, id, input, resume));
  }
}
