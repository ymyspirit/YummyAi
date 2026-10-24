import { FactoryCollaborationWorkbench } from "../../../features/factory-portal/factory-collaboration-workbench";
import {EntityIdSchema} from "@yummyai/contracts/common/ids";
export default async function FactoryCollaborationPage({searchParams}:{searchParams:Promise<{factoryId?:string|string[]}>}) {
  const query=await searchParams,id=EntityIdSchema.safeParse(query.factoryId);
  return <FactoryCollaborationWorkbench initialFactoryId={id.success?id.data:undefined}/>;
}
