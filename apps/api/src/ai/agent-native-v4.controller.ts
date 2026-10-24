import {
  BadRequestException, Body, Controller, Get, Header, HttpCode, Inject, Param, Post, Query, Req,
} from "@nestjs/common";
import {
  AgentNativeV4ItemReceiptQuerySchema, AgentNativeV4ReceiptQuerySchema, CreateAgentNativeV4Schema,
  PrepareAgentNativeV4ItemSchema, StopAgentNativeV4Schema,
} from "@yummyai/contracts/ai/agent-native-v4";
import { z } from "zod";
import type { AuthenticatedRequest } from "../auth/tenant-context.guard.js";
import { AgentNativeV4Service } from "./agent-native-v4.service.js";

const Empty = z.object({}).strict();
function input<T>(schema: z.ZodType<T>, raw: unknown): T {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new BadRequestException({ code: "agent_input_invalid" });
  return parsed.data;
}

// Like V3, no API-client metadata-read or verified POST exemption is granted.
// The global ApiClientRouteGuard retains its original personal-session boundary.
@Controller("v1/agent-native-v4")
export class AgentNativeV4Controller {
  constructor(@Inject(AgentNativeV4Service) private readonly service: AgentNativeV4Service) {}

  @Get("workspace") @Header("Cache-Control", "private, no-store")
  workspace(@Req() request: AuthenticatedRequest, @Query() query: unknown) {
    input(Empty, query); return this.service.workspace(request.tenantContext!);
  }

  @Post("runs") @HttpCode(201) @Header("Cache-Control", "private, no-store")
  start(@Req() request: AuthenticatedRequest, @Body() body: unknown, @Query() query: unknown) {
    input(Empty, query); return this.service.start(request.tenantContext!, input(CreateAgentNativeV4Schema, body));
  }

  @Get("runs/:id") @Header("Cache-Control", "private, no-store")
  get(@Req() request: AuthenticatedRequest, @Param("id") id: string, @Query() query: unknown) {
    input(Empty, query); return this.service.get(request.tenantContext!, id);
  }

  @Get("receipt") @Header("Cache-Control", "private, no-store")
  receipt(@Req() request: AuthenticatedRequest, @Query() query: unknown) {
    return this.service.receipt(request.tenantContext!, input(AgentNativeV4ReceiptQuerySchema, query));
  }

  @Post("runs/:id/stop") @HttpCode(200) @Header("Cache-Control", "private, no-store")
  stop(@Req() request: AuthenticatedRequest, @Param("id") id: string, @Body() body: unknown, @Query() query: unknown) {
    input(Empty, query); return this.service.stop(request.tenantContext!, id, input(StopAgentNativeV4Schema, body));
  }

  @Post("runs/:id/items/:itemId/prepare") @HttpCode(201) @Header("Cache-Control", "private, no-store")
  prepare(@Req() request: AuthenticatedRequest, @Param("id") id: string, @Param("itemId") itemId: string,
    @Body() body: unknown, @Query() query: unknown) {
    input(Empty, query); return this.service.prepareItem(request.tenantContext!, id, itemId, input(PrepareAgentNativeV4ItemSchema, body));
  }

  @Get("runs/:id/items/:itemId/receipt") @Header("Cache-Control", "private, no-store")
  itemReceipt(@Req() request: AuthenticatedRequest, @Param("id") id: string, @Param("itemId") itemId: string, @Query() query: unknown) {
    return this.service.itemReceipt(request.tenantContext!, id, itemId, input(AgentNativeV4ItemReceiptQuerySchema, query));
  }
}
