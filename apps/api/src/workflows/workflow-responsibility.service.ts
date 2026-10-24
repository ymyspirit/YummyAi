import { HttpException, Inject, Injectable } from "@nestjs/common";
import {
  WorkflowResponsibilityCoordinator,
  WorkflowResponsibilityError,
  WorkflowTaskInboxReader,
} from "@yummyai/workflow-core";
import type { TenantContext } from "@yummyai/contracts";
import type { WorkflowResponsibilityInput } from "@yummyai/contracts/workflow/responsibility";
import type { DatabaseConnection } from "@yummyai/database";
import { DATABASE_CONNECTION } from "../platform.tokens.js";
@Injectable()
export class WorkflowResponsibilityService {
  private readonly coordinator: WorkflowResponsibilityCoordinator;
  private readonly taskInbox: WorkflowTaskInboxReader;
  constructor(@Inject(DATABASE_CONNECTION) database: DatabaseConnection) {
    this.coordinator = new WorkflowResponsibilityCoordinator(database);
    this.taskInbox = new WorkflowTaskInboxReader(database);
  }
  private async call<T>(action: () => Promise<T>) {
    try {
      return await action();
    } catch (error) {
      if (error instanceof WorkflowResponsibilityError)
        throw new HttpException({ message: error.message }, error.status);
      throw error;
    }
  }
  get(context: TenantContext, runId: string, nodeId: string, query = "") {
    return this.call(() => this.coordinator.get(context, runId, nodeId, query));
  }
  tasks(context: TenantContext, query: unknown) {
    return this.call(() => this.taskInbox.list(context, query));
  }
  update(
    context: TenantContext,
    runId: string,
    nodeId: string,
    input: WorkflowResponsibilityInput,
  ) {
    return this.call(() => this.coordinator.update(context, runId, nodeId, input));
  }
}
