import { Inject, Injectable } from "@nestjs/common";
import type { SecretVault } from "@yummyai/ai-core";
import { authorize, Permission } from "@yummyai/authz";
import type { TenantContext } from "@yummyai/contracts";
import type { DatabaseConnection } from "@yummyai/database";
import { SharedAgentToolsGateway } from "@yummyai/workflow-core";
import { DATABASE_CONNECTION, INTEGRATION_SECRET_VAULT } from "../platform.tokens.js";
import { AgentCommandOwnerAdapter } from "./agent-command-owner.js";
import { AgentToolOwners } from "./agent-tool-owners.js";
import { rethrowAgentReadError } from "./agent-read-errors.js";

@Injectable()
export class AgentToolsService {
  private readonly gateway: SharedAgentToolsGateway;
  constructor(@Inject(DATABASE_CONNECTION) database: DatabaseConnection, @Inject(INTEGRATION_SECRET_VAULT) vault: SecretVault,
    @Inject(AgentToolOwners) owners: AgentToolOwners, @Inject(AgentCommandOwnerAdapter) commands: AgentCommandOwnerAdapter) {
    this.gateway = new SharedAgentToolsGateway(database, vault, owners, context => {
      let canRun = true;
      try { authorize(context, Permission.WorkflowRead, { ownerId: context.userId }); authorize(context, Permission.WorkflowRun, { ownerId: context.userId }); }
      catch { canRun = false; }
      return commands.capabilities(context).map(item => ({ ...item, available: canRun && item.available,
        blockReason: canRun ? item.blockReason : "workflow_run_required" }));
    });
  }
  workspace(context: TenantContext) { return this.adapt(() => this.gateway.workspace(context)); }
  definition(context: TenantContext, raw: unknown) { return this.adapt(() => this.gateway.definition(context, raw)); }
  call(context: TenantContext, raw: unknown) { return this.adapt(() => this.gateway.call(context, raw)); }
  private async adapt<T>(action: () => Promise<T>): Promise<T> { try { return await action(); } catch (error) { rethrowAgentReadError(error); } }
}
