import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
  Req,
  Res,
  BadRequestException,
} from "@nestjs/common";
import type { ServerResponse } from "node:http";
import { z } from "zod";
import type { AuthenticatedRequest } from "../auth/tenant-context.guard.js";
import { AgentChatService } from "./agent-chat.service.js";

const empty = (value: unknown) => {
  if (!z.object({}).strict().safeParse(value).success) throw new BadRequestException();
};
@Controller("v1/agent-chat")
export class AgentChatController {
  constructor(@Inject(AgentChatService) private readonly service: AgentChatService) {}
  @Get("workspace")
  @Header("Cache-Control", "private, no-store")
  workspace(@Req() request: AuthenticatedRequest, @Query() query: unknown) {
    empty(query);
    return this.service.workspace(request.tenantContext!);
  }
  @Get("conversations/:id")
  @Header("Cache-Control", "private, no-store")
  history(@Req() request: AuthenticatedRequest, @Param("id") id: string, @Query() query: unknown) {
    empty(query);
    return this.service.history(request.tenantContext!, id);
  }
  @Post("turns")
  @HttpCode(201)
  @Header("Cache-Control", "private, no-store")
  create(@Req() request: AuthenticatedRequest, @Body() body: unknown, @Query() query: unknown) {
    empty(query);
    return this.service.create(request.tenantContext!, body);
  }
  @Post("runs/:id/stream")
  @HttpCode(200)
  execute(
    @Req() request: AuthenticatedRequest,
    @Param("id") id: string,
    @Body() body: unknown,
    @Query() query: unknown,
    @Res() response: ServerResponse,
  ) {
    empty(query);
    return this.stream(request, id, body, response);
  }
  @Get("runs/:id/stream")
  observe(
    @Req() request: AuthenticatedRequest,
    @Param("id") id: string,
    @Query() query: unknown,
    @Res() response: ServerResponse,
  ) {
    empty(query);
    return this.stream(request, id, undefined, response);
  }
  private async stream(
    request: AuthenticatedRequest,
    id: string,
    body: unknown | undefined,
    response: ServerResponse,
  ) {
    const controller = new AbortController(),
      close = () => controller.abort();
    let completed = false;
    response.on("close", close);
    try {
      await this.service.stream(
        request.tenantContext!,
        id,
        body,
        async (event) => {
          if (controller.signal.aborted) return;
          if (!response.headersSent) {
            response.statusCode = 200;
            response.setHeader("Content-Type", "text/event-stream; charset=utf-8");
            response.setHeader("Cache-Control", "private, no-store, no-transform");
            response.setHeader("X-Accel-Buffering", "no");
            response.setHeader("X-Content-Type-Options", "nosniff");
            response.setHeader("x-yummyai-context-authority", event.contextAuthority);
            response.flushHeaders();
          }
          response.write(`data: ${JSON.stringify(event)}\n\n`);
        },
        controller.signal,
      );
      completed = true;
    } finally {
      response.off("close", close);
      if ((completed || response.headersSent) && !response.writableEnded) response.end();
    }
  }
}
