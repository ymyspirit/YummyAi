import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Header,
  Inject,
  Param,
  Post,
  Query,
  Req,
} from "@nestjs/common";
import { z } from "zod";
import { ModelBillingOwnerSchema } from "@yummyai/contracts/ai/model-billing";
import type { AuthenticatedRequest } from "../auth/tenant-context.guard.js";
import { ModelBillingService } from "./model-billing.service.js";
function reference(owner: string, id: string) {
  const o = ModelBillingOwnerSchema.safeParse(owner),
    i = z.uuidv7().safeParse(id);
  if (!o.success || !i.success) throw new BadRequestException("费用记录编号不正确");
  return { owner: o.data, id: i.data };
}
@Controller("v1/model-billing")
export class ModelBillingController {
  constructor(@Inject(ModelBillingService) private readonly service: ModelBillingService) {}
  @Get("workspace")
  @Header("Cache-Control", "private, no-store")
  workspace(@Req() r: AuthenticatedRequest, @Query() query: unknown) {
    return this.service.workspace(r.tenantContext!, query);
  }
  @Get(":owner/:id")
  @Header("Cache-Control", "private, no-store")
  basis(@Req() r: AuthenticatedRequest, @Param("owner") owner: string, @Param("id") id: string) {
    const ref = reference(owner, id);
    return this.service.basis(r.tenantContext!, ref.owner, ref.id);
  }
  @Post(":owner/:id/confirm")
  @Header("Cache-Control", "private, no-store")
  confirm(
    @Req() r: AuthenticatedRequest,
    @Param("owner") owner: string,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    const ref = reference(owner, id);
    return this.service.confirm(r.tenantContext!, ref.owner, ref.id, body);
  }
}
