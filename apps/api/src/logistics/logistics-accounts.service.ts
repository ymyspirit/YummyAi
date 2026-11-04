import { ConflictException,Inject,Injectable,NotFoundException } from "@nestjs/common";
import { authorize,ForbiddenError,Permission } from "@yummyai/authz";
import type { SecretVault } from "@yummyai/ai-core";
import { createEntityId,type TenantContext } from "@yummyai/contracts";
import { LogisticsCredentialsSchema,SaveLogisticsAccountSchema,type LogisticsAccountView,type LogisticsConnectionProfile } from "@yummyai/contracts/logistics";
import { logisticsAccounts as accounts,logisticsAccountVersions as versions,logisticsEvents as events,withTenant,type DatabaseConnection,type TenantTransaction } from "@yummyai/database";
import { HttpLogisticsGateway,LogisticsTransportError,logisticsHash,logisticsLock } from "@yummyai/logistics";
import { and,desc,eq } from "drizzle-orm";
import { z } from "zod";
import { DATABASE_CONNECTION,INTEGRATION_SECRET_VAULT } from "../platform.tokens.js";

@Injectable()
export class LogisticsAccountsService {
  constructor(@Inject(DATABASE_CONNECTION) private readonly database:DatabaseConnection,@Inject(INTEGRATION_SECRET_VAULT) private readonly vault:SecretVault,@Inject(HttpLogisticsGateway) private readonly gateway:HttpLogisticsGateway){}
  private access(context:TenantContext,write=false){authorize(context,write?Permission.IntegrationManage:Permission.IntegrationRead);if(context.dataScope!=="tenant")throw new ForbiddenError(Permission.IntegrationRead);}
  async list(context:TenantContext):Promise<{accounts:LogisticsAccountView[]}>{
    this.access(context);
    return withTenant(this.database.db,context,async tx=>({accounts:(await tx.select({account:accounts,version:versions}).from(accounts).innerJoin(versions,and(eq(versions.accountId,accounts.id),eq(versions.version,accounts.version))).orderBy(desc(accounts.createdAt)).limit(200)).map(({account,version})=>({id:account.id,version:account.version,versionId:version.id,profile:version.profile,verifiedAt:account.verifiedVersionId===version.id?account.verifiedAt?.toISOString()??null:null,channels:account.verifiedVersionId===version.id?account.channels:[]}))}));
  }
  async save(context:TenantContext,raw:unknown){
    this.access(context,true);const input=SaveLogisticsAccountSchema.parse(raw);
    if(input.profile.baseUrl){try{this.gateway.assertAccount(input.profile);}catch{throw new ConflictException("API 地址尚未核验 请使用已确认的 HTTPS 接口地址 或留空保存待配置账户");}}
    const digest=logisticsHash(input);
    return withTenant(this.database.db,context,async tx=>{
      await logisticsLock(tx,context,"api-accounts");
      const [replay]=await tx.select().from(versions).where(eq(versions.requestKey,input.idempotencyKey));
      if(replay){if(replay.requestHash!==digest)throw new ConflictException("请求编号已用于其他账户资料");return {accountId:replay.accountId,version:replay.version};}
      const id=input.accountId??createEntityId();
      const [current]=await tx.select().from(accounts).where(eq(accounts.id,id));
      if(input.accountId&&!current)throw new NotFoundException("物流 API 账户不存在");
      if((current?.version??0)!==input.expectedVersion)throw new ConflictException("账户版本已变化 请刷新后重试");
      const [previous]=current?await tx.select().from(versions).where(and(eq(versions.accountId,id),eq(versions.version,current.version))):[];
      if(previous&&previous.profile.provider!==input.profile.provider)throw new ConflictException("服务商不能修改 请新建对应账户");
      const credentials=input.credentials??(previous?this.vault.withSecret(previous.encryptedCredentials,s=>LogisticsCredentialsSchema.parse(JSON.parse(s))):null);
      if(!credentials||credentials.provider!==input.profile.provider)throw new ConflictException("请填写此服务商的 API 凭据");
      if(previous&&previous.profile.provider==="yunexpress"&&(previous.profile.yunexpressProtocol??"oms")!==(input.profile.yunexpressProtocol??"oms")&&!input.credentials)throw new ConflictException("切换接口协议时请重新填写对应凭据");
      try{this.gateway.assertCredentials(input.profile,credentials);}catch{throw new ConflictException("请补齐当前协议所需凭据 开放平台需要 AppId AppSecret 和 sourceKey");}
      const version=(current?.version??0)+1,versionId=createEntityId();
      if(!current)await tx.insert(accounts).values({id,tenantId:context.tenantId,createdBy:context.userId,version});
      await tx.insert(versions).values({id:versionId,tenantId:context.tenantId,createdBy:context.userId,accountId:id,version,profile:input.profile,encryptedCredentials:this.vault.encrypt(JSON.stringify(credentials)),requestKey:input.idempotencyKey,requestHash:digest});
      if(current)await tx.update(accounts).set({version,verifiedVersionId:null,verifiedAt:null,channels:[]}).where(eq(accounts.id,id));
      await tx.insert(events).values({id:createEntityId(),tenantId:context.tenantId,createdBy:context.userId,action:"account.saved",data:{accountId:id,versionId}});
      return {accountId:id,version};
    });
  }
  async verify(context:TenantContext,id:string,raw:unknown){
    this.access(context,true);const input=z.object({expectedVersion:z.int().positive()}).strict().parse(raw);
    const version=await withTenant(this.database.db,context,async tx=>{
      const [v]=await tx.select().from(versions).where(and(eq(versions.accountId,id),eq(versions.version,input.expectedVersion)));
      const [account]=await tx.select().from(accounts).where(eq(accounts.id,id));
      if(!v||!account)throw new NotFoundException("物流 API 账户不存在");
      if(account.version!==input.expectedVersion)throw new ConflictException("账户已更新 请刷新后重新测试");
      return v;
    });
    if(!version.profile.baseUrl)throw new ConflictException("请先补充此账户对应的正式 HTTPS API 地址");
    let channels:Array<{code:string;name:string}>;
    try{const credentials=this.vault.withSecret(version.encryptedCredentials,s=>LogisticsCredentialsSchema.parse(JSON.parse(s)));channels=await this.gateway.accountChannels(version.profile,credentials);}
    catch(error){
      const reasons:Record<string,string>={"0200412002":"AppId 或 AppSecret 不匹配 请检查开放平台应用凭据","0200401002":"访问令牌无效 请检查应用授权","0200401102":"签名校验失败 请检查密钥和服务器时间","0200403001":"云途限制了访问 IP 请核对该应用的 IP 授权","0200403101":"此应用尚未开通所需 API 权限","0200503001":"云途应用已停用 请在开放平台检查应用状态"};
      const reason=error instanceof LogisticsTransportError?reasons[error.providerCode??""]:undefined;
      throw new ConflictException(reason??"连接测试失败 请核对接口版本 地址和凭据 未创建物流订单");
    }
    return withTenant(this.database.db,context,async tx=>{
      await logisticsLock(tx,context,"api-accounts");
      const [current]=await tx.select().from(accounts).where(eq(accounts.id,id));
      if(current?.version!==version.version)throw new ConflictException("账户已更新 请重新测试");
      await tx.update(accounts).set({verifiedVersionId:version.id,verifiedAt:new Date(),channels}).where(eq(accounts.id,id));
      await tx.insert(events).values({id:createEntityId(),tenantId:context.tenantId,createdBy:context.userId,action:"account.verified",data:{accountId:id,versionId:version.id,channelCount:channels.length}});
      return {verified:true,channels};
    });
  }
  async credentialsForRoute(tx:TenantTransaction,context:TenantContext,id:string,profile:LogisticsConnectionProfile){
    this.access(context,true);
    const [row]=await tx.select({version:versions,account:accounts}).from(versions).innerJoin(accounts,eq(accounts.id,versions.accountId)).where(eq(versions.id,id)).for("share",{of:accounts});
    if(!row||row.account.verifiedVersionId!==id||row.account.version!==row.version.version)throw new ConflictException("请选择已测试通过的当前 API 账户版本");
    if(row.version.profile.provider!==profile.provider||row.version.profile.baseUrl!==profile.baseUrl||(row.version.profile.yunexpressProtocol??"oms")!==(profile.yunexpressProtocol??"oms"))throw new ConflictException("账户服务商 接口协议和地址须与工厂发货路线一致");
    return this.vault.withSecret(row.version.encryptedCredentials,s=>LogisticsCredentialsSchema.parse(JSON.parse(s)));
  }
}
