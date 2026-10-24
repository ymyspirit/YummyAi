import { ClipboardList } from "lucide-react";
import type { FactoryManufacturingPlan } from "@yummyai/contracts/order/manufacturing-delivery";
import "./manufacturing-delivery-summary.css";

export const manufacturingQuantityUnit = (unit?: "each" | "pair" | "set") => unit ? { each: "件", pair: "双", set: "套" }[unit] : "个订购单位";
const fraction = (numerator: string, denominator: string) => denominator === "1" ? numerator : `${numerator}/${denominator}`;
const supply = { merchant: "商家供料", factory: "工厂供料" };

export function ManufacturingDeliverySummary({ plan, instructions }: { plan: FactoryManufacturingPlan | null | undefined; instructions?: string }) {
  return <section className="manufacturing-delivery-summary" aria-label="本次制造清单">
    <h3><ClipboardList size={16} aria-hidden="true" />本次制造清单{plan && <span>V{plan.versionNumber}</span>}</h3>
    {plan ? <>
      <p><strong>{plan.name}</strong> · {plan.code}</p>
      <p>本次 {plan.quantity} {manufacturingQuantityUnit(plan.unit)} · 以下配方每份产出 {plan.recipeOutputQuantity} {manufacturingQuantityUnit(plan.unit)}</p>
      <details open><summary>材料与供料责任 {plan.materials.length} 项</summary><ul>
        {plan.materials.map(line => <li key={line.code}>
          <div><strong>{line.name}</strong><small>{line.code}{line.operationCode ? ` · 工序 ${line.operationCode}` : ""}</small></div>
          <div><span>计划 {fraction(line.plannedNumerator, line.plannedDenominator)} {line.unit}</span><small>{supply[line.responsibility]} · 损耗 {line.lossBps / 100}% {line.lossBasis === "add_to_net" ? "按净耗加计" : "占投入量"}</small></div>
        </li>)}
      </ul></details>
      <details open><summary>制造工序 {plan.operations.length} 项</summary><ol>
        {plan.operations.map(line => <li key={line.code}><div><strong>{line.name}</strong><small>{line.code} · {line.processCode}</small></div>
          <span>{line.responsibility === "factory" ? "工厂执行" : "商家执行"}</span></li>)}
      </ol></details>
      <p className="manufacturing-delivery-summary-note">用量为本次计划依据 实际收料与耗用另行登记</p>
      <p className="manufacturing-delivery-summary-hash">清单校验值 <code>{plan.checksum}</code></p>
    </> : <p className="manufacturing-delivery-summary-note">历史交付未固定制造清单 保留原文件与回执 请向运营核对原生产要求</p>}
    {instructions && <div className="manufacturing-delivery-summary-instructions"><strong>本单生产说明</strong><p>{instructions}</p></div>}
  </section>;
}
