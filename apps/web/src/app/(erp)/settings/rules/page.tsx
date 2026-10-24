import { Suspense } from "react";
import { RuleCenter } from "../../../../features/rules/rule-center";
export const metadata = { title: "规则中心 · YummyAI" };
export default function Page() { return <Suspense fallback={<main className="oc-page" role="status">正在读取规则…</main>}><RuleCenter /></Suspense>; }
