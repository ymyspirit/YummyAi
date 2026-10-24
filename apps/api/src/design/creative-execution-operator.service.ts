import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import type { TenantContext } from "@yummyai/contracts";
import type { CreativeHistoryScope } from "@yummyai/contracts/harness/creative-operator";
import type { DatabaseConnection } from "@yummyai/database";
import { CreativeExecutionOperatorOwner, CreativeExecutionOperatorOwnerError } from "@yummyai/pod-core";
import { DATABASE_CONNECTION } from "../platform.tokens.js";

async function apiResult<T>(operation: () => Promise<T>): Promise<T> {
  try { return await operation(); }
  catch (error) {
    if (error instanceof CreativeExecutionOperatorOwnerError) {
      if (error.status === 404) throw new NotFoundException(error.body);
      throw new ConflictException(error.body);
    }
    // These are the same catalog-owner errors mapped by the original API bridge.
    if (error instanceof Error && "status" in error && error.status === 404) throw new NotFoundException(error.message);
    if (error instanceof Error && "status" in error && error.status === 409) throw new ConflictException(error.message);
    throw error;
  }
}

@Injectable()
export class CreativeExecutionOperatorService {
  private readonly owner: CreativeExecutionOperatorOwner;
  constructor(@Inject(DATABASE_CONNECTION) database: DatabaseConnection) {
    this.owner = new CreativeExecutionOperatorOwner(database);
  }

  async history(context: TenantContext, scope: CreativeHistoryScope, id: string, rawQuery: unknown = {}) {
    return apiResult(() => this.owner.history(context, scope, id, rawQuery));
  }

  async act(context: TenantContext, id: string, rawInput: unknown) {
    return apiResult(() => this.owner.act(context, id, rawInput));
  }
}
