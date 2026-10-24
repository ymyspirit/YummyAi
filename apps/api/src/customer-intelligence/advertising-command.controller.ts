import {BadRequestException,Body,Controller,Get,Header,HttpCode,Inject,Param,Post,Query,Req} from "@nestjs/common";
import {EntityIdSchema} from "@yummyai/contracts/common/ids";
import {AdCommandAccountQuerySchema,AdCommandEmptyBodySchema,PrepareAdCommandSchema} from "@yummyai/contracts/advertising/command";
import {z} from "zod";
import type {AuthenticatedRequest} from "../auth/tenant-context.guard.js";
import {AdvertisingCommandService} from "./advertising-command.service.js";
function input<T>(schema:z.ZodType<T>,raw:unknown){const result=schema.safeParse(raw);if(!result.success)throw new BadRequestException({code:"advertising_command_input_invalid",message:"广告原提交填写或查询格式不正确"});return result.data;}
const id=EntityIdSchema.transform(value=>value.toLowerCase()),empty=z.object({}).strict();
function context(request:AuthenticatedRequest){if(!request.tenantContext)throw new Error("Tenant context is required");return request.tenantContext;}
/** Kind-specific current account authority is an OR service check, not an AND permission decorator. */
@Controller("v1/advertising/commands")
export class AdvertisingCommandController{
  constructor(@Inject(AdvertisingCommandService)private readonly commands:AdvertisingCommandService){}
  @Post() @HttpCode(201) @Header("Cache-Control","private, no-store")
  prepare(@Req() request:AuthenticatedRequest,@Body() body:unknown,@Query() query:unknown){input(empty,query);return this.commands.prepare(context(request),input(PrepareAdCommandSchema,body));}
  @Get() @Header("Cache-Control","private, no-store")
  list(@Req() request:AuthenticatedRequest,@Query() query:unknown){return this.commands.list(context(request),query);}
  @Get(":commandId") @Header("Cache-Control","private, no-store")
  get(@Req() request:AuthenticatedRequest,@Param("commandId") commandId:string,@Query() query:unknown){return this.commands.get(context(request),input(id,commandId),input(AdCommandAccountQuerySchema,query).accountId);}
  @Get(":commandId/original") @Header("Cache-Control","private, no-store")
  original(@Req() request:AuthenticatedRequest,@Param("commandId") commandId:string,@Query() query:unknown){return this.commands.original(context(request),input(id,commandId),input(AdCommandAccountQuerySchema,query).accountId);}
  @Post(":commandId/execute") @HttpCode(200) @Header("Cache-Control","private, no-store")
  execute(@Req() request:AuthenticatedRequest,@Param("commandId") commandId:string,@Query() query:unknown,@Body() body:unknown){input(AdCommandEmptyBodySchema,body);return this.commands.execute(context(request),input(id,commandId),input(AdCommandAccountQuerySchema,query).accountId);}
  @Post(":commandId/cancel") @HttpCode(200) @Header("Cache-Control","private, no-store")
  cancel(@Req() request:AuthenticatedRequest,@Param("commandId") commandId:string,@Query() query:unknown,@Body() body:unknown){input(AdCommandEmptyBodySchema,body);return this.commands.cancel(context(request),input(id,commandId),input(AdCommandAccountQuerySchema,query).accountId);}
  @Post(":commandId/acknowledge") @HttpCode(200) @Header("Cache-Control","private, no-store")
  acknowledge(@Req() request:AuthenticatedRequest,@Param("commandId") commandId:string,@Query() query:unknown,@Body() body:unknown){input(AdCommandEmptyBodySchema,body);return this.commands.acknowledge(context(request),input(id,commandId),input(AdCommandAccountQuerySchema,query).accountId);}
}
