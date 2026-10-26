import { BadGatewayException, BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { authorize, erpPermissionContext, ForbiddenError, Permission, type PermissionValue } from "@yummyai/authz";
import type { TenantContext } from "@yummyai/contracts";
import { erpSessionAuthority } from "@yummyai/contracts/auth/session";
import {
  STUDIO_PERSONAL_VERSION, StudioPersonalInvokeSchema, StudioPersonalReplySchema, StudioWorkspaceQuerySchema,
  StudioWorkspaceSchema, type StudioPersonalReply, type StudioWorkspace,
} from "@yummyai/contracts/pod/studio-personal";
import { withTenant, type DatabaseConnection, type TenantTransaction } from "@yummyai/database";
import { DATABASE_CONNECTION } from "../platform.tokens.js";
import { currentCreativeWorkspaceAuthority } from "./canvas-workflow-access.js";
import { CreativeStudioService } from "./creative-studio.service.js";
import { currentDesignAuthority } from "./design-access.js";
import { studioImageAdmission } from "@yummyai/pod-core";

const stamp = (context: TenantContext) => erpSessionAuthority(erpPermissionContext(context));
const changed = () => new ConflictException({ code: "authority_changed", message: "当前本人权限已变化 请重新核对" });
const invalidReply = () => new BadGatewayException({ code: "studio_personal_reply_invalid", message: "创作响应格式无效" });

/** Personal-session transport only. Original owners retain every business write. */
@Injectable()
export class CreativeStudioPersonalService {
  constructor(
    @Inject(DATABASE_CONNECTION) private readonly database: DatabaseConnection,
    @Inject(CreativeStudioService) private readonly studio: CreativeStudioService,
  ) {}

  private personal(context: TenantContext) {
    // The original RPC also supports explicit server adapters. They cannot be
    // adopted here by inventing a membership or filling in missing scopes.
    if (!context.permissionScopes || typeof context.permissionScopes !== "object")
      throw new ForbiddenException({ code: "studio_personal_session_required", message: "需要有效的本人会员会话" });
  }

  private async current(context: TenantContext, scope: string, cancellationOnly = false) {
    this.personal(context);
    return withTenant(this.database.db, context, async tx =>
      (await (cancellationOnly ? currentDesignAuthority(tx, context, [Permission.DesignRead, Permission.AssetRead])
        : currentCreativeWorkspaceAuthority(tx, context, scope))).authority);
  }

  private async allowed(tx: TenantTransaction, context: TenantContext, scope: string, extra: readonly PermissionValue[]) {
    try {
      await currentCreativeWorkspaceAuthority(tx, context, scope, extra);
      return true;
    } catch (error) {
      if (error instanceof ForbiddenError || error instanceof NotFoundException || error instanceof ConflictException) return false;
      throw error;
    }
  }

  async workspace(context: TenantContext, rawQuery: unknown): Promise<StudioWorkspace> {
    const parsed = StudioWorkspaceQuerySchema.safeParse(rawQuery);
    if (!parsed.success) throw new BadRequestException({ code: "studio_personal_input_invalid", message: "创作工作区参数无效" });
    this.personal(context);
    const { scope } = parsed.data;
    const workspace = await withTenant(this.database.db, context, async tx => {
      const { authority } = await currentCreativeWorkspaceAuthority(tx, context, scope);
      const save = await this.allowed(tx, authority, scope, [Permission.DesignWrite]);
      const mediaWrite = await this.allowed(tx, authority, scope, [Permission.DesignWrite, Permission.AssetWrite]);
      const review = await this.allowed(tx, authority, scope, [Permission.DesignReview]);
      let configure = false;
      try { authorize(authority, Permission.ModelConfigure); configure = true; }
      catch (error) { if (!(error instanceof ForbiddenError)) throw error; }
      return StudioWorkspaceSchema.parse({
        version: STUDIO_PERSONAL_VERSION, scope, contextAuthority: stamp(authority),
        originalHandoffVersion: 1,
        documentTransferVersion: 1,
        videoDirectoryVersion: 1,
        paidImageVersion: 1,
        paidImageAdmission: studioImageAdmission(context.tenantId),
        capabilities: { read: true, save, mediaWrite, review, submit: scope !== "unassigned" && mediaWrite, configure },
        generation: { enabled: false, code: "operator_paused" },
      });
    // Original membership and object gates use FOR SHARE; this transaction
    // performs no writes but must permit those original PostgreSQL row locks.
    }, { isolationLevel: "repeatable read", accessMode: "read write" });
    if (stamp(await this.current(context, scope)) !== workspace.contextAuthority) throw changed();
    return workspace;
  }

  async invoke(context: TenantContext, raw: unknown): Promise<StudioPersonalReply> {
    const parsed = StudioPersonalInvokeSchema.safeParse(raw);
    if (!parsed.success) throw new BadRequestException({ code: "studio_personal_input_invalid", message: "创作请求格式无效" });
    const { request, contextAuthority } = parsed.data;
    const cancellationOnly = request.operation === "paid.image.abandon";
    const authority = await this.current(context, request.scope, cancellationOnly);
    if (stamp(authority) !== contextAuthority) throw changed();
    if (request.operation === "result.submit")
      throw new ConflictException({ code: "studio_original_pin_required", message: "送审需要固定原稿版本 请刷新创作工作台后重试" });
    // Includes generation.get's original idempotent candidate submission. Never
    // repeat this call as a read/access probe or as a response-validation retry.
    const original = await this.studio.invoke(authority, request);
    let data: unknown;
    try { data = JSON.parse(JSON.stringify(original)); }
    catch { throw invalidReply(); }
    const reply = StudioPersonalReplySchema.safeParse({
      version: STUDIO_PERSONAL_VERSION, scope: request.scope, contextAuthority, operation: request.operation, data,
    });
    if (!reply.success) throw invalidReply();
    if (stamp(await this.current(context, request.scope, cancellationOnly)) !== contextAuthority) throw changed();
    return reply.data;
  }
}
