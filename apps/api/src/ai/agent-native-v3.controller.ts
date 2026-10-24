import {
  BadRequestException, Body, Controller, Get, Header, HttpCode, Inject, Param, Post, Query, Req,
} from "@nestjs/common";
import { z } from "zod";
import {
  AgentNativeV3ReceiptQuerySchema, CreateAgentNativeV3Schema, PrepareAgentNativeV3ItemSchema, StopAgentNativeV3Schema,
} from "@yummyai/contracts/ai/agent-native-v3";
import type { AuthenticatedRequest } from "../auth/tenant-context.guard.js";
import { AgentNativeV3Service } from "./agent-native-v3.service.js";

const Empty = z.object({}).strict();
function input<T>(schema: z.ZodType<T>, raw: unknown): T {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new BadRequestException({ code: "agent_input_invalid" });
  return parsed.data;
}

@Controller("v1/agent-native-v3")
export class AgentNativeV3Controller {
  constructor(@Inject(AgentNativeV3Service) private readonly service: AgentNativeV3Service) {}

  @Get("workspace") @Header("Cache-Control", "private, no-store")
  workspace(@Req() request: AuthenticatedRequest, @Query() query: unknown) {
    input(Empty, query); return this.service.workspace(request.tenantContext!);
  }

  @Post("runs") @HttpCode(201) @Header("Cache-Control", "private, no-store")
  start(@Req() request: AuthenticatedRequest, @Body() body: unknown, @Query() query: unknown) {
    input(Empty, query); return this.service.start(request.tenantContext!, input(CreateAgentNativeV3Schema, body));
  }

  @Get("runs/:id") @Header("Cache-Control", "private, no-store")
  get(@Req() request: AuthenticatedRequest, @Param("id") id: string, @Query() query: unknown) {
    input(Empty, query); return this.service.get(request.tenantContext!, id);
  }

  @Get("receipt") @Header("Cache-Control", "private, no-store")
  receipt(@Req() request: AuthenticatedRequest, @Query() query: unknown) {
    return this.service.receipt(request.tenantContext!, input(AgentNativeV3ReceiptQuerySchema, query));
  }

  @Post("runs/:id/stop") @HttpCode(200) @Header("Cache-Control", "private, no-store")
  stop(@Req() request: AuthenticatedRequest, @Param("id") id: string, @Body() body: unknown, @Query() query: unknown) {
    input(Empty, query); return this.service.stop(request.tenantContext!, id, input(StopAgentNativeV3Schema, body));
  }

  @Post("runs/:id/items/:itemId/prepare") @HttpCode(201) @Header("Cache-Control", "private, no-store")
  prepare(@Req() request: AuthenticatedRequest, @Param("id") id: string, @Param("itemId") itemId: string,
    @Body() body: unknown, @Query() query: unknown) {
    input(Empty, query); return this.service.prepareItem(request.tenantContext!, id, itemId, input(PrepareAgentNativeV3ItemSchema, body));
  }

  @Post("runs/:id/items/:itemId/receipt") @HttpCode(200) @Header("Cache-Control", "private, no-store")
  itemReceipt(@Req() request: AuthenticatedRequest, @Param("id") id: string, @Param("itemId") itemId: string,
    @Body() body: unknown, @Query() query: unknown) {
    input(Empty, query); return this.service.itemReceipt(request.tenantContext!, id, itemId, input(PrepareAgentNativeV3ItemSchema, body));
  }
}
