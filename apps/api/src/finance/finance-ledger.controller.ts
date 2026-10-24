import { BadRequestException, Controller, Get, Header, Inject, Param, Query, Req } from "@nestjs/common";
import { authorize, Permission } from "@yummyai/authz";

import { RequiresPermission } from "../auth/permissions.decorator.js";
import type { AuthenticatedRequest } from "../auth/tenant-context.guard.js";
import { FinanceLedgerService } from "./finance-ledger.service.js";

@Controller("v1/finance/ledger")
export class FinanceLedgerController {
  constructor(@Inject(FinanceLedgerService) private readonly service: FinanceLedgerService) {}

  @Get(":kind")
  @Header("Cache-Control", "private, no-store")
  @RequiresPermission(Permission.FinanceRead)
  list(@Req() request: AuthenticatedRequest, @Param("kind") kind: string, @Query() query: unknown) {
    const context = requireContext(request);
    authorize(context, Permission.FinanceRead);
    return this.service.list(context, routeQuery(query, { kind }));
  }

  @Get(":kind/:id")
  @Header("Cache-Control", "private, no-store")
  @RequiresPermission(Permission.FinanceRead)
  detail(@Req() request: AuthenticatedRequest, @Param("kind") kind: string, @Param("id") id: string, @Query() query: unknown) {
    const context = requireContext(request);
    authorize(context, Permission.FinanceRead);
    return this.service.detail(context, routeQuery(query, { kind, id }));
  }
}

function requireContext(request: AuthenticatedRequest) {
  if (!request.tenantContext) throw new Error("Tenant context is required");
  return request.tenantContext;
}

function routeQuery(raw: unknown, route: { kind: string; id?: string }) {
  const query = raw === undefined ? {} : raw;
  if (!query || typeof query !== "object" || Array.isArray(query) || Object.hasOwn(query, "kind") || Object.hasOwn(query, "id"))
    throw new BadRequestException({ code: "finance_ledger_input_invalid", message: "财务台账查询格式不正确" });
  return { ...query, ...route };
}
