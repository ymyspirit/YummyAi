import { LogisticsWorkspace } from "../../../features/logistics/logistics-workspace";
export const dynamic = "force-dynamic";
export default async function LogisticsPage({searchParams}:{searchParams:Promise<{orderId?:string;task?:string}>}) {
  const query=await searchParams;
  return <LogisticsWorkspace orderId={query.orderId} taskId={query.task} />;
}
