import {BadRequestException,Body,ConflictException,Controller,Get,Header,Inject,NotFoundException,Param,Post,Req,Query} from "@nestjs/common";
import {OrderDesignAgentReadQuerySchema} from "@yummyai/contracts/order/design-agent";
import {Permission} from "@yummyai/authz";
import type {SecretVault} from "@yummyai/ai-core";
import type {DatabaseConnection} from "@yummyai/database";
import type {Storage} from "@yummyai/storage";
import {OrderDesignRepository,OrderDesignError,OrderDesignResponseRecovery} from "@yummyai/order-design";
import {z} from "zod";
import {RequiresPermission} from "../auth/permissions.decorator.js";
import type {AuthenticatedRequest} from "../auth/tenant-context.guard.js";
import {DATABASE_CONNECTION,ORDER_PII_VAULT,PRIVATE_STORAGE} from "../platform.tokens.js";
@Controller("v1/order-centers/lines/:id/design-agent")
export class OrderDesignAgentController {
  private readonly repository:OrderDesignRepository;
  private readonly recovery:OrderDesignResponseRecovery;
  constructor(@Inject(DATABASE_CONNECTION) database:DatabaseConnection,@Inject(ORDER_PII_VAULT) vault:SecretVault,@Inject(PRIVATE_STORAGE) storage:Storage){this.repository=new OrderDesignRepository(database,vault);this.recovery=new OrderDesignResponseRecovery(database,vault,storage);}
  @Get() @Header("Cache-Control","private, no-store") @RequiresPermission(Permission.OrderRead)
  view(@Req() request:AuthenticatedRequest,@Param("id") id:string,@Query() query:unknown){const read=OrderDesignAgentReadQuerySchema.safeParse(query);if(!read.success)throw new BadRequestException("Invalid design evidence view");return boundary(()=>this.repository.view(context(request),z.uuidv7().parse(id),{includePrivate:read.data.view==="full"}));}
  @Post("resume") @Header("Cache-Control","private, no-store") @RequiresPermission(Permission.OrderWrite)
  resume(@Req() request:AuthenticatedRequest,@Param("id") id:string,@Body() body:unknown,@Query() query:unknown){assertWriteQuery(query);return boundary(()=>this.repository.command(context(request),z.uuidv7().parse(id),"resume",body));}
  @Post("takeover") @Header("Cache-Control","private, no-store") @RequiresPermission(Permission.OrderWrite)
  takeover(@Req() request:AuthenticatedRequest,@Param("id") id:string,@Body() body:unknown,@Query() query:unknown){assertWriteQuery(query);return boundary(()=>this.repository.command(context(request),z.uuidv7().parse(id),"takeover",body));}
  @Post("restore-response") @Header("Cache-Control","private, no-store") @RequiresPermission(Permission.OrderWrite,Permission.OrderPiiRead,Permission.DesignWrite,Permission.AssetRead)
  restoreResponse(@Req() request:AuthenticatedRequest,@Param("id") id:string,@Body() body:unknown,@Query() query:unknown){assertWriteQuery(query);return boundary(async()=>{
    const scope=context(request),workId=z.uuidv7().parse(id);
    await this.recovery.restore(scope,workId,body);
    return this.repository.view(scope,workId);
  });}
}
function context(request:AuthenticatedRequest){if(!request.tenantContext)throw new Error("Tenant context required");return request.tenantContext;}
function assertWriteQuery(query:unknown){if(!z.object({}).strict().safeParse(query).success)throw new BadRequestException("Design commands do not accept query parameters");}
async function boundary<T>(callback:()=>Promise<T>){try{return await callback();}catch(error){if(error instanceof OrderDesignError){if(error.code.endsWith("not_found"))throw new NotFoundException(error.code);throw new ConflictException(error.code);}throw error;}}
