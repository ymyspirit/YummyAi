import { Inject,Injectable } from "@nestjs/common";
import type { TenantContext } from "@yummyai/contracts";
import type { DatabaseConnection } from "@yummyai/database";
import { ResearchReadOwner,type ResearchFilters } from "@yummyai/knowledge-core";
import { DATABASE_CONNECTION } from "../platform.tokens.js";
import { originalOwnerOperation } from "../shared/original-owner-error.js";
export type { ResearchFilters } from "@yummyai/knowledge-core";
@Injectable()
export class ResearchRepository {
private readonly owner:ResearchReadOwner;
constructor(@Inject(DATABASE_CONNECTION) database:DatabaseConnection){this.owner=new ResearchReadOwner(database);}
list(context:TenantContext,filters:ResearchFilters={}){return originalOwnerOperation(()=>this.owner.list(context,filters));}
productTypes(context:TenantContext,visibility:ResearchFilters['visibility']='active'){return originalOwnerOperation(()=>this.owner.productTypes(context,visibility));}
timeline(context:TenantContext,researchItemId:string){return originalOwnerOperation(()=>this.owner.timeline(context,researchItemId));}
snapshotCount(context:TenantContext,researchItemId:string){return originalOwnerOperation(()=>this.owner.snapshotCount(context,researchItemId));}
}
