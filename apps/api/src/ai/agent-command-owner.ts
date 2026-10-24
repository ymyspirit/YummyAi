import { BadRequestException, ConflictException, Inject, Injectable } from "@nestjs/common";
import { agentCommandCapabilities } from "@yummyai/workflow-core";
import type { TenantContext } from "@yummyai/contracts";
import {
  AgentCommandBindingSchema, AgentCommandOwnerReferenceSchema, AgentCommandOwnerSnapshotSchema,
  normalizeAgentCommandOriginal, type AgentCommandBinding, type AgentCommandCapability,
  type AgentCommandNativeView, type AgentCommandOriginal, type AgentCommandOwnerReference,
  type AgentCommandOwnerSnapshot,
} from "@yummyai/contracts/ai/agent-command";
import { canonicalFinanceCommandOriginal } from "@yummyai/contracts/finance/finance-command";
import { createHash } from "node:crypto";
import { ProcurementCommandService } from "../procurement/procurement-command.service.js";
import { procurementCommandBinding } from "../procurement/procurement-original-request.js";
import { IncomingCommandService, incomingCommandRequestChecksum } from "../procurement/incoming-command.service.js";
import { FinanceCommandService } from "../finance/finance-command.service.js";
import { AdvertisingCommandService } from "../customer-intelligence/advertising-command.service.js";
import { advertisingCommandChecksum } from "../customer-intelligence/advertising-command-transaction.js";
import { ProductionCommandService } from "../orders/production-command.service.js";
import { productionCommandDescriptor } from "../orders/production-command-fence.js";

const sha = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
/** Coordinates existing command owners; it never writes a business table or acknowledges an outcome implicitly. */
@Injectable()
export class AgentCommandOwnerAdapter {
  constructor(
    @Inject(ProcurementCommandService) private readonly procurement: ProcurementCommandService,
    @Inject(IncomingCommandService) private readonly incoming: IncomingCommandService,
    @Inject(ProductionCommandService) private readonly production: ProductionCommandService,
    @Inject(FinanceCommandService) private readonly finance: FinanceCommandService,
    @Inject(AdvertisingCommandService) private readonly advertising: AdvertisingCommandService,
  ) {}

  binding(raw: AgentCommandOriginal): AgentCommandBinding {
    const original = normalizeAgentCommandOriginal(raw);
    const common = { domain: original.domain, kind: original.command.kind, targetId: original.command.targetId,
      accountId: original.domain === "advertising" ? original.command.accountId : null,
      requestKeyHash: sha(original.command.input.idempotencyKey) };
    switch (original.domain) {
      case "procurement": return AgentCommandBindingSchema.parse({ ...common,
        ownerRequestChecksum: procurementCommandBinding(original.command).requestChecksum });
      case "incoming": return AgentCommandBindingSchema.parse({ ...common,
        ownerRequestChecksum: incomingCommandRequestChecksum(original.command) });
      case "production": {
        const descriptor = productionCommandDescriptor(original.command);
        return AgentCommandBindingSchema.parse({ ...common, targetId: descriptor.targetId,
          ownerRequestChecksum: descriptor.requestChecksum });
      }
      case "finance": return AgentCommandBindingSchema.parse({ ...common,
        ownerRequestChecksum: sha(canonicalFinanceCommandOriginal(original.command)) });
      case "advertising": return AgentCommandBindingSchema.parse({ ...common,
        ownerRequestChecksum: advertisingCommandChecksum(original.command) });
    }
  }

  locate(context: TenantContext, raw: AgentCommandBinding): Promise<AgentCommandOwnerReference | null> {
    const binding = AgentCommandBindingSchema.parse(raw);
    switch (binding.domain) {
      case "procurement": return this.procurement.locateForAgent(context, binding);
      case "incoming": return this.incoming.locateForAgent(context, binding);
      case "production": return this.production.locateForAgent(context, binding);
      case "finance": return this.finance.locateForAgent(context, binding);
      case "advertising": return this.advertising.locateForAgent(context, binding);
    }
  }

  async prepare(context: TenantContext, raw: AgentCommandOriginal): Promise<AgentCommandOwnerSnapshot> {
    const original = normalizeAgentCommandOriginal(raw);
    switch (original.domain) {
      case "procurement": {
        const view = await this.procurement.prepare(context, original.command);
        return this.snapshot(context, ref("procurement", view.id), { domain: "procurement", view });
      }
      case "incoming": {
        const view = await this.incoming.prepare(context, original.command);
        return this.snapshot(context, ref("incoming", view.id), { domain: "incoming", view });
      }
      case "production": {
        const view = await this.production.prepare(context, original.command);
        return this.snapshot(context, ref("production", view.id), { domain: "production", view });
      }
      case "finance": {
        const view = await this.finance.prepare(context, original.command);
        return this.snapshot(context, ref("finance", view.id), { domain: "finance", view });
      }
      case "advertising": {
        const view = await this.advertising.prepare(context, original.command);
        return this.snapshot(context, ref("advertising", view.id, original.command.accountId), { domain: "advertising", view });
      }
    }
  }

  async read(context: TenantContext, raw: AgentCommandOwnerReference): Promise<AgentCommandOwnerSnapshot> {
    const reference = checkedReference(raw), id = reference.commandId;
    switch (reference.domain) {
      case "procurement": return this.snapshot(context, reference, { domain: "procurement", view: await this.procurement.get(context, id) });
      case "incoming": return this.snapshot(context, reference, { domain: "incoming", view: await this.incoming.get(context, id) });
      case "production": return this.snapshot(context, reference, { domain: "production", view: await this.production.get(context, id) });
      case "finance": return this.snapshot(context, reference, { domain: "finance", view: await this.finance.get(context, id) });
      case "advertising": return this.snapshot(context, reference, { domain: "advertising", view: await this.advertising.get(context, id, account(reference)) });
    }
  }

  execute(context: TenantContext, reference: AgentCommandOwnerReference): Promise<AgentCommandOwnerSnapshot> {
    return this.action(context, reference, "execute");
  }
  cancel(context: TenantContext, reference: AgentCommandOwnerReference): Promise<AgentCommandOwnerSnapshot> {
    return this.action(context, reference, "cancel");
  }
  acknowledge(context: TenantContext, reference: AgentCommandOwnerReference): Promise<AgentCommandOwnerSnapshot> {
    return this.action(context, reference, "acknowledge");
  }

  capabilities(context: TenantContext): AgentCommandCapability[] { return agentCommandCapabilities(context); }

  private async action(context: TenantContext, raw: AgentCommandOwnerReference,
    action: "execute" | "cancel" | "acknowledge"): Promise<AgentCommandOwnerSnapshot> {
    const reference = checkedReference(raw), id = reference.commandId;
    switch (reference.domain) {
      case "procurement": return this.snapshot(context, reference, { domain: "procurement", view: await this.procurement[action](context, id) });
      case "incoming": return this.snapshot(context, reference, { domain: "incoming", view: await this.incoming[action](context, id) });
      case "production": return this.snapshot(context, reference, { domain: "production", view: await this.production[action](context, id) });
      case "finance": return this.snapshot(context, reference, { domain: "finance", view: await this.finance[action](context, id) });
      case "advertising": return this.snapshot(context, reference, { domain: "advertising", view: await this.advertising[action](context, id, account(reference)) });
    }
  }

  private async snapshot(context: TenantContext, reference: AgentCommandOwnerReference,
    native: AgentCommandNativeView): Promise<AgentCommandOwnerSnapshot> {
    let original: AgentCommandOriginal | null = null;
    switch (native.domain) {
      case "procurement": if (native.view.original) original = { domain: "procurement", command: native.view.original }; break;
      case "incoming": if (native.view.original) original = { domain: "incoming", command: native.view.original }; break;
      case "production": {
        const command = await this.production.originalForAgent(context, reference.commandId);
        if (command) original = { domain: "production", command };
        break;
      }
      case "finance": {
        const saved = await this.finance.original(context, reference.commandId);
        sameAuthority(native.view.contextAuthority, saved.contextAuthority);
        if (saved.original) original = { domain: "finance", command: saved.original };
        break;
      }
      case "advertising": {
        const saved = await this.advertising.original(context, reference.commandId, account(reference));
        sameAuthority(native.view.contextAuthority, saved.contextAuthority);
        if (saved.original) original = { domain: "advertising", command: saved.original };
        break;
      }
    }
    // Preserve every native status, receipt and authority stamp, including an
    // already-succeeded production existing_receipt; it is never a new execution.
    return AgentCommandOwnerSnapshotSchema.parse({ reference, native, original });
  }
}

function ref(domain: AgentCommandBinding["domain"], commandId: string, accountId: string | null = null): AgentCommandOwnerReference {
  return { domain, commandId, accountId };
}
function checkedReference(raw: AgentCommandOwnerReference): AgentCommandOwnerReference {
  const value = AgentCommandOwnerReferenceSchema.parse(raw);
  if (value.domain === "advertising" ? value.accountId === null : value.accountId !== null)
    throw new BadRequestException({ code: "agent_command_reference_invalid", message: "原命令引用与业务账户不一致" });
  return value;
}
function account(reference: AgentCommandOwnerReference): string {
  if (!reference.accountId) throw new BadRequestException({ code: "agent_command_reference_invalid", message: "广告原命令缺少固定账户" });
  return reference.accountId;
}
function sameAuthority(left: string, right: string) {
  if (left !== right) throw new ConflictException({ code: "agent_command_authority_changed", message: "当前权限已变化 请重新读取原命令" });
}
