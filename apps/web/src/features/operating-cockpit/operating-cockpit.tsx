import type { IntegrationWorkspaceView } from "@yummyai/contracts/integration";
import type {
  ForecastRunView,
  PlanningWorkspaceView,
} from "@yummyai/contracts/planning";
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  Clock3,
  KeyRound,
  Link2,
  RefreshCcw,
  Route,
  Send,
  ShieldCheck,
  Webhook,
} from "lucide-react";
import Link from "next/link";

interface OperatingCockpitProps {
  integration: IntegrationWorkspaceView | null;
  planning: PlanningWorkspaceView | null;
}

export function OperatingCockpit({ integration, planning }: OperatingCockpitProps) {
  if (!planning && !integration) {
    return (
      <section className="operating-cockpit-empty" aria-labelledby="operating-cockpit-empty-title">
        <Activity size={32} />
        <strong id="operating-cockpit-empty-title">运营信号暂不可用</strong>
        <span>预测与开放集成工作区均未能读取；恢复连接后会显示固定输入、指标状态和投递证据。</span>
      </section>
    );
  }

  const openReconciliations = planning?.reconciliations.filter((item) => item.status === "open") ?? [];
  const unhealthyMetrics = planning?.metricProjections.filter((item) => item.snapshot.state !== "current") ?? [];
  const deadLetters = integration?.webhookDeliveries.filter((delivery) => delivery.status === "dead_letter") ?? [];
  const pendingDeliveries = integration?.webhookDeliveries.filter((delivery) =>
    ["pending", "delivering", "retry_scheduled"].includes(delivery.status),
  ) ?? [];

  return (
    <div className="operating-cockpit-workspace">
      <section className="operating-cockpit-chain" aria-label="运营证据链">
        <ChainStep
          code="PINNED INPUT"
          detail={planning ? `${planning.forecasts.length} 个不可变运行` : "规划工作区不可用"}
          icon={<Route size={16} />}
          label="预测输入"
          state={planning ? "ready" : "missing"}
        />
        <ArrowRight aria-hidden="true" size={17} />
        <ChainStep
          code="CURRENT PROJECTION"
          detail={planning ? `${unhealthyMetrics.length} 个指标待处理` : "指标投影不可用"}
          icon={<Activity size={16} />}
          label="运营指标"
          state={unhealthyMetrics.length ? "warning" : planning ? "ready" : "missing"}
        />
        <ArrowRight aria-hidden="true" size={17} />
        <ChainStep
          code="RECONCILIATION"
          detail={planning ? `${openReconciliations.length} 个开放事项` : "对账队列不可用"}
          icon={<RefreshCcw size={16} />}
          label="人工对账"
          state={openReconciliations.length ? "warning" : planning ? "ready" : "missing"}
        />
        <ArrowRight aria-hidden="true" size={17} />
        <ChainStep
          code="SIGNED DELIVERY"
          detail={integration ? `${deadLetters.length} 个死信 · ${pendingDeliveries.length} 个进行中` : "投递工作区不可用"}
          icon={<Webhook size={16} />}
          label="事件投递"
          state={deadLetters.length ? "danger" : integration ? "ready" : "missing"}
        />
      </section>

      <section className="operating-cockpit-signals" aria-label="运营驾驶舱摘要">
        <Signal code="FORECASTS" label="预测运行" value={planning?.forecasts.length ?? null} />
        <Signal code="METRIC GAPS" label="异常指标" tone={unhealthyMetrics.length ? "amber" : "green"} value={planning ? unhealthyMetrics.length : null} />
        <Signal code="OPEN QUEUE" label="开放对账" tone={openReconciliations.length ? "amber" : "green"} value={planning ? openReconciliations.length : null} />
        <Signal code="DEAD LETTERS" label="Webhook 死信" tone={deadLetters.length ? "red" : "green"} value={integration ? deadLetters.length : null} />
      </section>

      <ForecastSection planning={planning} />
      <MetricSection planning={planning} />

      <div className="operating-cockpit-columns">
        <ReconciliationSection planning={planning} />
        <IntegrationRegistry integration={integration} />
      </div>

      <DeliverySection integration={integration} />
    </div>
  );
}

function ForecastSection({ planning }: { planning: PlanningWorkspaceView | null }) {
  return (
    <section className="operating-cockpit-panel" aria-labelledby="operating-forecasts-title">
      <PanelHeader
        code="PINNED WINDOW / QUANTILES / ACCURACY"
        detail={planning ? `${planning.forecasts.length} 个预测运行` : "规划工作区不可用"}
        id="operating-forecasts-title"
        title="预测版本"
      />
      {!planning ? <InlineState message="无法读取预测运行。" unavailable /> : planning.forecasts.length ? (
        <div className="operating-cockpit-table-scroll">
          <table className="operating-cockpit-table operating-forecast-table">
            <thead><tr><th>指标 / 范围</th><th>固定输入</th><th>模型</th><th>P10</th><th>P50</th><th>P90</th><th>准确度</th><th>覆盖版本</th></tr></thead>
            <tbody>{planning.forecasts.map((run) => {
              const point = run.points[0];
              const accuracy = run.accuracy[0];
              const override = run.overrides.at(-1);
              return (
                <tr key={run.id}>
                  <td><strong>{metricLabel(run.metric)}</strong><code>{scopeLabel(run)} · {run.grain}</code></td>
                  <td><time dateTime={run.inputWindowStart}>{formatDate(run.inputWindowStart)}</time><span>至 {formatDate(run.inputWindowEnd)}</span><small>截止 {formatDateTime(run.evidenceCutoffAt)}</small></td>
                  <td><strong>{modelLabel(run.model)}</strong><code>{run.modelVersion}</code></td>
                  <td className="numeric">{quantileValue(point?.values, 1_000)}</td>
                  <td className="numeric is-median">{quantileValue(point?.values, 5_000)}</td>
                  <td className="numeric">{quantileValue(point?.values, 9_000)}</td>
                  <td>{accuracy ? <><strong>MAE {formatInteger(accuracy.meanAbsoluteError)}</strong><span>WAPE {formatBps(accuracy.weightedAbsolutePercentageErrorBps)}</span></> : <span>尚未评估</span>}</td>
                  <td>{override ? <><strong>V{override.versionNumber}</strong><code>{override.reasonCode}</code></> : <span>原始预测</span>}</td>
                </tr>
              );
            })}</tbody>
          </table>
        </div>
      ) : <InlineState message="还没有预测运行；创建后会固定输入窗口、证据截止点和模型版本。" />}
    </section>
  );
}

function MetricSection({ planning }: { planning: PlanningWorkspaceView | null }) {
  const definitions = new Map(planning?.metricDefinitions.map((definition) => [definition.id, definition]));
  return (
    <section className="operating-cockpit-panel" aria-labelledby="operating-metrics-title">
      <PanelHeader
        code="FRESHNESS / COMPLETENESS / DRILL-THROUGH"
        detail={planning ? `${planning.metricProjections.length} 个当前投影` : "指标工作区不可用"}
        id="operating-metrics-title"
        title="指标状态矩阵"
      />
      {!planning ? <InlineState message="无法读取运营指标投影。" unavailable /> : planning.metricProjections.length ? (
        <div className="operating-cockpit-table-scroll">
          <table className="operating-cockpit-table operating-metric-table">
            <thead><tr><th>指标</th><th>状态</th><th>当前值</th><th>完整度</th><th>观测时间</th><th>新鲜度</th><th>来源</th><th>下钻</th></tr></thead>
            <tbody>{planning.metricProjections.map((projection) => {
              const definition = definitions.get(projection.definitionId);
              const snapshot = projection.snapshot;
              return (
                <tr key={projection.definitionId}>
                  <td><strong>{definition?.name ?? "未知指标"}</strong><code>{definition?.key ?? projection.definitionId}</code></td>
                  <td><StatusBadge state={snapshot.state} /></td>
                  <td className="numeric is-median">{formatMetricValue(snapshot.value, definition?.version.unit)}</td>
                  <td><strong>{formatBps(snapshot.completenessBps)}</strong><span>阈值 {formatBps(definition?.version.minimumCompletenessBps ?? null)}</span></td>
                  <td><time dateTime={snapshot.observedAt}>{formatDateTime(snapshot.observedAt)}</time></td>
                  <td><strong>{formatAge(snapshot.ageSeconds)}</strong><span>上限 {formatAge(definition?.version.maximumAgeSeconds)}</span></td>
                  <td><strong>{sourceLabel(definition?.version.source)}</strong><span>{snapshot.sourceRefs.length} 条证据</span></td>
                  <td><Link className="operating-cockpit-drill" href={snapshot.drillThroughHref}><Link2 size={13} />查看</Link></td>
                </tr>
              );
            })}</tbody>
          </table>
        </div>
      ) : <InlineState message="还没有运营指标投影；记录指标快照后会显示新鲜度和完整度。" />}
    </section>
  );
}

function ReconciliationSection({ planning }: { planning: PlanningWorkspaceView | null }) {
  const items = planning?.reconciliations.filter((item) => item.status === "open") ?? [];
  return (
    <section className="operating-cockpit-panel" aria-labelledby="operating-reconciliation-title">
      <PanelHeader code="OPEN WORK" detail={planning ? `${items.length} 个待处理` : "队列不可用"} id="operating-reconciliation-title" title="对账队列" />
      {!planning ? <InlineState message="无法读取对账队列。" unavailable /> : items.length ? (
        <ol className="operating-cockpit-list">{items.slice(0, 12).map((item) => (
          <li key={item.id}>
            <AlertTriangle size={15} />
            <div><strong>{reconciliationCategoryLabel(item.category)}</strong><code>{item.code}</code><span>{item.sourceRef ? `${item.sourceRef.sourceType} · ${shortId(item.sourceRef.sourceId)}` : "指标状态触发"}</span></div>
            <time dateTime={item.openedAt}>{formatDateTime(item.openedAt)}</time>
          </li>
        ))}</ol>
      ) : <InlineState icon="check" message="没有开放的运营对账事项。" />}
    </section>
  );
}

function IntegrationRegistry({ integration }: { integration: IntegrationWorkspaceView | null }) {
  return (
    <section className="operating-cockpit-panel" aria-labelledby="operating-integrations-title">
      <PanelHeader code="LEAST PRIVILEGE / SIGNED EVENTS" detail={integration ? `${integration.apiClients.length} 个客户端 · ${integration.webhookEndpoints.length} 个端点` : "集成工作区不可用"} id="operating-integrations-title" title="开放集成" />
      {!integration ? <InlineState message="无法读取 API 客户端和 Webhook 端点。" unavailable /> : !integration.apiClients.length && !integration.webhookEndpoints.length ? <InlineState message="还没有 API 客户端或 Webhook 端点。" /> : (
        <div className="operating-cockpit-registry">
          <div><header><KeyRound size={14} /><strong>API 客户端</strong></header><ol>{integration.apiClients.map((client) => <li key={client.id}><div><strong>{client.label}</strong><code>{client.keyPrefix}…</code></div><span className={`registry-status status-${client.status}`}>{client.status === "active" ? "有效" : "已撤销"}</span><small>{client.scopes.length} 个只读范围</small></li>)}</ol>{!integration.apiClients.length ? <InlineState message="尚无 API 客户端。" /> : null}</div>
          <div><header><Webhook size={14} /><strong>Webhook 端点</strong></header><ol>{integration.webhookEndpoints.map((endpoint) => <li key={endpoint.id}><div><strong>{endpoint.label}</strong><code>{endpoint.url}</code></div><span className={`registry-status status-${endpoint.status}`}>{endpoint.status === "active" ? "启用" : "停用"}</span><small>V{endpoint.version} · 最多 {endpoint.maxAttempts} 次</small></li>)}</ol>{!integration.webhookEndpoints.length ? <InlineState message="尚无 Webhook 端点。" /> : null}</div>
        </div>
      )}
    </section>
  );
}

function DeliverySection({ integration }: { integration: IntegrationWorkspaceView | null }) {
  return (
    <section className="operating-cockpit-panel" aria-labelledby="operating-deliveries-title">
      <PanelHeader code="HMAC V1 / RETRY / RETENTION" detail={integration ? `${integration.webhookDeliveries.length} 次投递 · ${integration.retentionRuns.length} 次保留清理` : "投递工作区不可用"} id="operating-deliveries-title" title="签名投递与恢复" />
      {!integration ? <InlineState message="无法读取投递与保留记录。" unavailable /> : integration.webhookDeliveries.length ? (
        <div className="operating-cockpit-table-scroll">
          <table className="operating-cockpit-table operating-delivery-table">
            <thead><tr><th>状态</th><th>事件</th><th>端点</th><th>尝试</th><th>最近结果</th><th>签名</th><th>下一次 / 完成</th><th>恢复链</th></tr></thead>
            <tbody>{integration.webhookDeliveries.map((delivery) => {
              const event = integration.webhookEvents.find((item) => item.id === delivery.eventId);
              const endpoint = integration.webhookEndpoints.find((item) => item.id === delivery.endpointId);
              const attempt = delivery.attempts.at(-1);
              return (
                <tr key={delivery.id}>
                  <td><DeliveryStatus status={delivery.status} /></td>
                  <td><strong>{event?.eventType ?? "未知事件"}</strong><code>{shortId(delivery.eventId)}</code></td>
                  <td><strong>{endpoint?.label ?? "未知端点"}</strong><code>{shortId(delivery.endpointId)}</code></td>
                  <td className="numeric">{delivery.attemptCount} / {delivery.maxAttempts}</td>
                  <td><strong>{attempt ? attemptOutcomeLabel(attempt.outcome) : "等待首次投递"}</strong><span>{attempt?.responseStatus ?? attempt?.failureCode ?? "—"}</span></td>
                  <td><span className="signature-badge"><ShieldCheck size={13} />{attempt ? attempt.signatureVersion.toUpperCase() : "待签名"}</span></td>
                  <td><time dateTime={delivery.nextAttemptAt ?? delivery.completedAt ?? delivery.createdAt}>{formatDateTime(delivery.nextAttemptAt ?? delivery.completedAt ?? delivery.createdAt)}</time></td>
                  <td>{delivery.replayOfDeliveryId ? <><strong>手动重放</strong><code>{shortId(delivery.replayOfDeliveryId)}</code></> : <span>原始投递</span>}</td>
                </tr>
              );
            })}</tbody>
          </table>
        </div>
      ) : <InlineState message="尚无 Webhook 投递；事件发布后会记录签名版本、尝试和恢复链。" />}
      {integration?.retentionRuns.length ? <footer className="operating-cockpit-retention"><Clock3 size={14} /><span>最近保留清理：{formatDateTime(integration.retentionRuns[0]!.completedAt)}</span><b>{integration.retentionRuns[0]!.redactedEventCount} 个载荷已脱敏</b></footer> : null}
    </section>
  );
}

function ChainStep({ code, detail, icon, label, state }: { code: string; detail: string; icon: React.ReactNode; label: string; state: "ready" | "warning" | "danger" | "missing" }) {
  return <div className={`operating-chain-step state-${state}`}>{icon}<small>{code}</small><strong>{label}</strong><span>{detail}</span></div>;
}

function Signal({ code, label, tone = "blue", value }: { code: string; label: string; tone?: "blue" | "green" | "amber" | "red"; value: number | null }) {
  return <div className={`operating-cockpit-signal signal-${tone}`}><small>{code}</small><span>{label}</span><b>{value ?? "—"}</b></div>;
}

function PanelHeader({ code, detail, id, title }: { code: string; detail: string; id: string; title: string }) {
  return <header><div><small>{code}</small><h2 id={id}>{title}</h2></div><span>{detail}</span></header>;
}

function InlineState({ icon = "alert", message, unavailable = false }: { icon?: "alert" | "check"; message: string; unavailable?: boolean }) {
  return <p className={unavailable ? "operating-cockpit-inline-state is-unavailable" : "operating-cockpit-inline-state"}>{icon === "check" ? <CheckCircle2 size={15} /> : <AlertTriangle size={15} />}{message}</p>;
}

function StatusBadge({ state }: { state: PlanningWorkspaceView["metricProjections"][number]["snapshot"]["state"] }) {
  const label = { current: "当前", stale: "过期", incomplete: "不完整", unavailable: "不可用" }[state];
  return <span className={`operating-state-badge state-${state}`}>{state === "current" ? <CheckCircle2 size={13} /> : <AlertTriangle size={13} />}{label}</span>;
}

function DeliveryStatus({ status }: { status: IntegrationWorkspaceView["webhookDeliveries"][number]["status"] }) {
  const label = { pending: "等待", delivering: "投递中", retry_scheduled: "待重试", succeeded: "成功", dead_letter: "死信" }[status];
  return <span className={`delivery-status status-${status}`}>{status === "succeeded" ? <CheckCircle2 size={13} /> : status === "delivering" ? <Send size={13} /> : <AlertTriangle size={13} />}{label}</span>;
}

function metricLabel(metric: ForecastRunView["metric"]) {
  return { sales_units: "销售量", inventory_available: "可售库存", profit_minor: "贡献利润" }[metric];
}

function modelLabel(model: ForecastRunView["model"]) {
  return model === "moving_average_v1" ? "移动平均" : "季节朴素";
}

function scopeLabel(run: ForecastRunView) {
  const label = { tenant: "租户", platform: "平台", store: "店铺", listing: "Listing", sku: "SKU" }[run.scopeType];
  return `${label} ${run.scopeKey}`;
}

function quantileValue(values: ForecastRunView["points"][number]["values"] | undefined, quantile: number) {
  const value = values?.find((item) => item.quantileBps === quantile)?.value;
  return value === undefined ? "—" : formatInteger(value);
}

function formatMetricValue(value: number | null, unit: PlanningWorkspaceView["metricDefinitions"][number]["version"]["unit"] | undefined) {
  if (value === null) return "不可用";
  if (unit === "basis_points") return formatBps(value);
  if (unit === "seconds") return formatAge(value);
  return formatInteger(value);
}

function sourceLabel(source: PlanningWorkspaceView["metricDefinitions"][number]["version"]["source"] | undefined) {
  return ({ forecast: "预测", inventory: "库存", finance: "财务", webhook: "Webhook", system: "系统" } as const)[source ?? "system"];
}

function reconciliationCategoryLabel(category: string) {
  return ({ freshness: "新鲜度", completeness: "完整度", projection: "投影漂移", provider: "提供方", webhook: "Webhook" } as Record<string, string>)[category] ?? category;
}

function attemptOutcomeLabel(outcome: IntegrationWorkspaceView["webhookDeliveries"][number]["attempts"][number]["outcome"]) {
  return { succeeded: "投递成功", retryable_failure: "可重试失败", terminal_failure: "终止失败" }[outcome];
}

function formatBps(value: number | null) {
  return value === null ? "—" : `${(value / 100).toFixed(2)}%`;
}

function formatInteger(value: number) {
  return new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 0 }).format(value);
}

function formatAge(value: number | undefined) {
  if (value === undefined) return "—";
  if (value < 60) return `${value} 秒`;
  if (value < 3_600) return `${Math.floor(value / 60)} 分钟`;
  if (value < 86_400) return `${Math.floor(value / 3_600)} 小时`;
  return `${Math.floor(value / 86_400)} 天`;
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit" }).format(new Date(value));
}

function formatDateTime(value: string) {
  return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(value));
}

function shortId(value: string) {
  return value.slice(0, 8);
}
