import { FunctionDirectory } from "../../../features/navigation/function-directory";
import { NAVIGATION_GROUPS } from "../../../features/navigation/navigation-registry";

export default async function NavigationPage({ searchParams }: { searchParams: Promise<{ group?: string }> }) {
  const { group } = await searchParams;
  const initialGroup = NAVIGATION_GROUPS.find((item) => item.id === (group === "research" ? "insights" : group))?.id ?? "commerce";
  return <main className="research-main erp-directory-main"><FunctionDirectory key={initialGroup} initialGroup={initialGroup} /></main>;
}
