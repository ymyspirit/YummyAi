import { BadRequestException, Controller, Get, Inject, Param, Query, Req } from "@nestjs/common";
import { authorize, Permission } from "@yummyai/authz";
import { InvoiceReconciliationQuerySchema } from "@yummyai/contracts/procurement/invoice-reconciliation";
import { z } from "zod";
import { RequiresPermission } from "../auth/permissions.decorator.js";
import type { AuthenticatedRequest } from "../auth/tenant-context.guard.js";
import { InvoiceReconciliationService } from "./invoice-reconciliation.service.js";

@Controller("v1/procurement/invoice-reconciliations")
export class InvoiceReconciliationController {
  constructor(@Inject(InvoiceReconciliationService) private readonly service: InvoiceReconciliationService) {}

  @Get()
  @RequiresPermission(Permission.ProcurementRead)
  list(@Req() request: AuthenticatedRequest, @Query() query: unknown) {
    const context = requireContext(request), parsed = InvoiceReconciliationQuerySchema.safeParse(query);
    if (!parsed.success) throw new BadRequestException("发票处理查询参数无效");
    authorize(context, Permission.ProcurementRead);
    return this.service.list(context, parsed.data);
  }

  @Get(":invoiceId")
  @RequiresPermission(Permission.ProcurementRead)
  detail(@Req() request: AuthenticatedRequest, @Param("invoiceId") invoiceId: string, @Query() query: unknown) {
    const context = requireContext(request), parsed = z.uuidv7().transform(v => v.toLowerCase()).safeParse(invoiceId);
    if (!parsed.success || !z.object({}).strict().safeParse(query).success) throw new BadRequestException("发票处理对象无效");
    authorize(context, Permission.ProcurementRead);
    return this.service.detail(context, parsed.data);
  }
}
function requireContext(request: AuthenticatedRequest) {
  if (!request.tenantContext) throw new Error("Tenant context is required");
  return request.tenantContext;
}
