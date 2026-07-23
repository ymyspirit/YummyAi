import type {
  ChannelAllocationRunView,
  ChannelInventoryWorkspaceView,
  NetworkStockCondition,
  NetworkStockSource,
} from "@yummyai/contracts/channel-inventory";
import {
  AlertTriangle,
  Boxes,
  CircleAlert,
  Layers3,
  Network,
  PackageCheck,
  ShieldCheck,
} from "lucide-react";

const sourceOrder: NetworkStockSource[] = [
  "owned",
  "fba",
  "fbm",
  "overseas_3pl",
  "supplier",
  "in_transit",
  "virtual",
];
const conditionOrder: NetworkStockCondition[] = ["sellable", "quarantine", "damaged"];

export function ChannelInventoryWorkspace({ data }: { data: ChannelInventoryWorkspaceView }) {
  const stockItems = new Map(data.stockItems.map((item) => [item.id, item]));
  const accounts = new Map(data.accounts.map((account) => [account.id, account]));
  const latestRuns = latestByPolicy(data.runs);
  const totals = latestRuns.reduce((summary, run) => ({
    eligible: summary.eligible + run.eligibleQuantity,
    allocatable: summary.allocatable + run.allocatableQuantity,
    allocated: summary.allocated + run.allocatedQuantity,
  }), { eligible: 0, allocatable: 0, allocated: 0 });
  const openReconciliations = data.reconciliations.filter((item) => item.status === "open");
  const matrix = buildEvidenceMatrix(data);

  if (!data.snapshots.length && !data.policies.length) {
    return (
      <section className="channel-inventory-empty" aria-labelledby="channel-inventory-empty-title">
        <Network size={32} />
        <strong id="channel-inventory-empty-title">还没有渠道库存证据</strong>
        <span>先接收服务商库存快照并建立分配策略。系统不会用商品库存或历史销量猜测渠道可售量。</span>
      </section>
    );
  }

  return (
    <>
      <section className="channel-inventory-signals" aria-label="渠道库存运营摘要">
        <Signal icon={<Boxes size={17} />} code="ELIGIBLE" label="符合策略库存" value={totals.eligible} tone="navy" />
        <Signal icon={<Layers3 size={17} />} code="ALLOCATABLE" label="扣除安全缓冲" value={totals.allocatable} tone="blue" />
        <Signal icon={<PackageCheck size={17} />} code="ALLOCATED" label="渠道可售总量" value={totals.allocated} tone="green" />
        <Signal icon={<AlertTriangle size={17} />} code="RECONCILE" label="待处理对账" value={openReconciliations.length} tone="red" />
      </section>

      <section className="channel-inventory-panel" aria-labelledby="network-evidence-title">
        <PanelHeader
          code="SOURCE × CONDITION"
          title="网络库存证据"
          detail={`${data.snapshots.length} 个不可变快照`}
        />
        <div className="channel-inventory-table-scroll">
          <table className="channel-inventory-table evidence-matrix">
            <thead>
              <tr><th>库存来源</th><th>可售</th><th>隔离</th><th>损坏</th><th>判断</th></tr>
            </thead>
            <tbody>
              {sourceOrder.map((source) => {
                const values = matrix.get(source) ?? { sellable: 0, quarantine: 0, damaged: 0 };
                return (
                  <tr key={source}>
                    <td><strong>{sourceLabel(source)}</strong><code>{source}</code></td>
                    {conditionOrder.map((condition) => (
                      <td key={condition}>
                        <b className={`evidence-quantity condition-${condition}`}>{values[condition]}</b>
                      </td>
                    ))}
                    <td>
                      <span className={source === "in_transit" || source === "virtual" ? "evidence-rule is-policy" : "evidence-rule"}>
                        {source === "in_transit" ? "默认不参与可售" : source === "virtual" ? "仅显式启用" : "按策略来源纳入"}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      <section className="channel-inventory-panel" aria-labelledby="channel-projection-title">
        <PanelHeader
          code="SNAPSHOT → POLICY → CHANNEL"
          title="当前渠道可售投影"
          detail={`${latestRuns.reduce((total, run) => total + run.projections.length, 0)} 个渠道目标`}
        />
        <div className="channel-inventory-table-scroll">
          <table className="channel-inventory-table channel-projection-table">
            <thead>
              <tr><th>物料</th><th>渠道 / 店铺</th><th>策略版本</th><th>优先级</th><th>上限</th><th>渠道缓冲</th><th>可售量</th><th>计算时间</th></tr>
            </thead>
            <tbody>
              {latestRuns.flatMap((run) => run.projections.map((projection) => {
                const stock = stockItems.get(projection.stockItemId);
                const account = accounts.get(projection.accountId);
                return (
                  <tr key={projection.id}>
                    <td><strong>{stock?.name ?? shortId(projection.stockItemId)}</strong><code>{stock?.code ?? shortId(projection.stockItemId)}</code></td>
                    <td><strong>{account?.displayName ?? shortId(projection.accountId)}</strong><span>{platformLabel(projection.platform)} · {projection.marketplaceId}</span></td>
                    <td><span className="policy-version">V{run.policyVersion}</span><code>{shortId(run.policyVersionId)}</code></td>
                    <td><b className="projection-number">{projection.priority}</b></td>
                    <td><b className="projection-number">{projection.capQuantity ?? "不限"}</b></td>
                    <td><b className="projection-number">{projection.bufferQuantity}</b></td>
                    <td><b className="projection-available">{projection.allocatedQuantity}</b><small>{unitLabel(projection.unit)}</small></td>
                    <td><time dateTime={projection.calculatedAt}>{formatDateTime(projection.calculatedAt)}</time></td>
                  </tr>
                );
              }))}
            </tbody>
          </table>
        </div>
        {!latestRuns.length ? <InlineEmpty message="策略已建立，但还没有基于当前版本的分配计算。" /> : null}
      </section>

      <div className="channel-inventory-columns">
        <section className="channel-inventory-panel" aria-labelledby="allocation-policy-title">
          <PanelHeader code="VERSIONED RULES" title="分配策略" detail={`${data.policies.length} 个物料策略`} />
          {data.policies.length ? (
            <ol className="channel-policy-list">
              {data.policies.map((policy) => {
                const stock = stockItems.get(policy.stockItemId);
                return (
                  <li key={policy.id}>
                    <span className="channel-list-icon"><ShieldCheck size={15} /></span>
                    <div>
                      <strong>{policy.name}</strong>
                      <span>{stock?.code ?? shortId(policy.stockItemId)} · {policy.version.eligibleSources.map(sourceLabel).join("、")}</span>
                    </div>
                    <b>V{policy.currentVersion}<small>缓冲 {policy.version.safetyBufferQuantity}</small></b>
                  </li>
                );
              })}
            </ol>
          ) : <InlineEmpty message="还没有渠道分配策略。" />}
        </section>

        <section className="channel-inventory-panel" aria-labelledby="channel-reconciliation-title">
          <PanelHeader code="UNCERTAIN MUTATIONS" title="渠道对账" detail={`${openReconciliations.length} 项待处理`} />
          {data.reconciliations.length ? (
            <ol className="channel-reconciliation-list">
              {data.reconciliations.map((item) => (
                <li key={item.id}>
                  <CircleAlert size={15} />
                  <div>
                    <strong>{accounts.get(item.accountId)?.displayName ?? shortId(item.accountId)}</strong>
                    <span>{item.reasonCode} · {item.message}</span>
                  </div>
                  <span className={`channel-reconciliation-status status-${item.status}`}>{reconciliationLabel(item.status)}</span>
                </li>
              ))}
            </ol>
          ) : <InlineEmpty message="当前没有不确定的渠道写入。" />}
        </section>
      </div>
    </>
  );
}

function Signal({
  icon,
  code,
  label,
  value,
  tone,
}: {
  icon: React.ReactNode;
  code: string;
  label: string;
  value: number;
  tone: "navy" | "blue" | "green" | "red";
}) {
  return (
    <div className={`channel-inventory-signal signal-${tone}`}>
      <span>{icon}</span>
      <p><small>{code}</small><strong>{label}</strong></p>
      <b>{value}</b>
    </div>
  );
}

function PanelHeader({ code, title, detail }: { code: string; title: string; detail: string }) {
  return (
    <header>
      <div><p className="section-code">{code}</p><h2>{title}</h2></div>
      <span>{detail}</span>
    </header>
  );
}

function InlineEmpty({ message }: { message: string }) {
  return <p className="channel-inventory-inline-empty"><CircleAlert size={15} />{message}</p>;
}

function latestByPolicy(runs: ChannelAllocationRunView[]) {
  const latest = new Map<string, ChannelAllocationRunView>();
  for (const run of runs) if (!latest.has(run.policyId)) latest.set(run.policyId, run);
  return [...latest.values()];
}

function buildEvidenceMatrix(data: ChannelInventoryWorkspaceView) {
  const latest = new Map<string, ChannelInventoryWorkspaceView["snapshots"][number]>();
  for (const snapshot of data.snapshots) {
    const key = `${snapshot.provider}:${snapshot.scopeKey}`;
    if (!latest.has(key)) latest.set(key, snapshot);
  }
  const matrix = new Map<NetworkStockSource, Record<NetworkStockCondition, number>>();
  for (const snapshot of latest.values()) {
    for (const line of snapshot.lines) {
      const values = matrix.get(line.source) ?? { sellable: 0, quarantine: 0, damaged: 0 };
      values[line.condition] += line.quantity;
      matrix.set(line.source, values);
    }
  }
  return matrix;
}

function sourceLabel(source: NetworkStockSource) {
  return ({
    owned: "自有库存",
    fba: "Amazon FBA",
    fbm: "商家履约 FBM",
    overseas_3pl: "海外仓 / 3PL",
    supplier: "供应商库存",
    in_transit: "在途库存",
    virtual: "虚拟库存",
  })[source];
}

function platformLabel(platform: "amazon" | "etsy") {
  return platform === "amazon" ? "Amazon" : "Etsy";
}

function reconciliationLabel(status: "open" | "confirmed" | "rejected") {
  return ({ open: "待对账", confirmed: "已确认", rejected: "已驳回" })[status];
}

function unitLabel(unit: string) {
  return ({ each: "件", pair: "对", set: "套", meter: "米", gram: "克", kilogram: "千克" } as Record<string, string>)[unit] ?? unit;
}

function formatDateTime(value: string) {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(value));
}

function shortId(value: string) {
  return value.slice(0, 8);
}
