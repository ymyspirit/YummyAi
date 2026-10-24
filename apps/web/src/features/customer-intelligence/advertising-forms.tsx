"use client";
import { useState, type FormEvent } from "react";
import {
  AdGoalFieldsSchema,
  AdSaveGoalInputSchema,
  AdGoalVersionSchema,
  AdObservationInputSchema,
  AdObservationSchema,
  AdActionEventInputSchema,
  AdActionViewSchema,
  AdProductScopeSchema,
  AdMarketplaceSchema,
  AdArchiveInputSchema,
  AdImportViewSchema,
  adCurrencyBasis,
  type AdConversionBasis,
  type AdCurrencyBasis,
  type AdFileMeasurement,
  type AdFactMeasurement,
  type AdProductScope,
  type AdGoalVersion,
  type AdObservationInput,
  type AdActionView,
  type AdActionStatus,
} from "@yummyai/contracts/advertising";
import {
  adIdempotency,
  adDayNow,
  adMajor,
  adInputMinor,
  adNextStates,
  adStatusLabels,
  adMoney,
  adMetricLabels,
  adConversionLabels,
} from "./advertising-client";
import type { useAdMutation } from "./advertising-client";
import { useAdCommandMutation, type AdCommandDraftScope } from "./advertising-command-forms";
import { AdCommandMutationPanel } from "./advertising-command-workbench";
import type { AdCommandDetail } from "@yummyai/contracts/advertising/command";

type FormProps = { onSaved: () => Promise<void>; onDirty: (dirty: boolean) => void; permitted?: boolean; onDenied?: (message: string) => void };
type Mutation = ReturnType<typeof useAdMutation> & { durable?: boolean; checking?: boolean; reload?: () => Promise<void> };
export function AdConversionSummary({ conversion }: { conversion?: AdConversionBasis | null }) {
  if (!conversion) return <p className="ad-note ad-conversion">原转化指标定义未保存 不按当前规则补填</p>;
  return <div className="ad-conversion">
    <p><strong>{conversion.state === "resolved" ? "转化依据已固定" : conversion.state === "conflict" ? "转化依据冲突" : "转化依据未确认"}</strong> · {adConversionLabels[conversion.model]} · {conversion.windowDays === null ? "窗口未知" : `${conversion.windowDays} 天`}</p>
    <p className="ad-note">指标定义依据 {conversion.source ?? "未提供"} · 来源说明与人工选择不代表平台外部验真</p>
  </div>;
}
export function AdMonetaryBasisNote({ currency, basis }: { currency: string | null; basis?: AdCurrencyBasis | null }) {
  return <p className="ad-note ad-monetary-basis">{basis
    ? `${basis.currency} · 原金额精度 ${basis.minorDigits} 位小数 · ${basis.currencyTableVersion}`
    : `${currency ?? "币种未知"} · 原金额精度未保存 保留原最小整数 不推测主单位`}</p>;
}
/** Shows only the measurement saved in this source or result; it never infers a historical basis. */
export function AdMeasurementSummary({ measurement, sourceFields, currency }: {
  measurement?: AdFileMeasurement | AdFactMeasurement | null;
  sourceFields?: Record<string, string>;
  currency?: string | null;
}) {
  if (!measurement) return <p className="ad-note ad-measurement-unknown">原测量依据未保存 实际采用列 转化定义与金额精度待核对 原始单元格继续保留</p>;
  return <section className="ad-measurement" aria-label="保存的测量依据">
    <p className="ad-note">适配版本 <code>{measurement.adapterVersion}</code> · 依据版本 {measurement.schemaVersion}</p>
    <AdConversionSummary conversion={measurement.conversion} />
    <dl className="ad-source-fields ad-measurement-columns">
      {(Object.keys(adMetricLabels) as Array<keyof typeof adMetricLabels>).map(metric => {
        const column = measurement.columns[metric];
        return <div key={metric}><dt>{adMetricLabels[metric]}采用列</dt><dd>{column === null ? "未采用原列" : <><code>{column}</code>{sourceFields && <span className="ad-original-cell">原单元格 {Object.hasOwn(sourceFields, column) ? sourceFields[column] || "空单元格" : "原单元格未提供"}</span>}</>}</dd></div>;
      })}
    </dl>
    {"currencies" in measurement ? <div className="ad-currency-bases" aria-label="报表币种精度清单">
      <strong>完整报表币种精度清单</strong>
      {measurement.currencies.length === 0 ? <p className="ad-note">未识别到可核对币种 不默认两位小数</p> : <ul>{measurement.currencies.map(basis => <li key={basis.currency}><code>{basis.currency}</code> · {basis.minorDigits === null ? "精度未知 不转换金额" : `${basis.minorDigits} 位小数`} · {basis.currencyTableVersion}</li>)}</ul>}
    </div> : <AdMonetaryBasisNote currency={currency ?? measurement.monetaryBasis?.currency ?? null} basis={measurement.monetaryBasis} />}
  </section>;
}
export function AdGoalMoneySummary({ goal }: { goal: AdGoalVersion }) {
  const fields = goal.fields, currency = goal.scope.currency;
  return <section className="ad-goal-money" aria-label="目标版本金额依据">
    <p className="ad-note">读取的目标版本 V{goal.revision} · <code>{goal.id}</code></p>
    <AdMonetaryBasisNote currency={currency} basis={fields.monetaryBasis} />
    <dl className="ad-source-fields"><div><dt>单件售价</dt><dd>{adMoney(fields.unitPriceMinor, currency, fields.monetaryBasis)}</dd></div><div><dt>单件广告前总成本</dt><dd>{adMoney(fields.unitCostMinor, currency, fields.monetaryBasis)}</dd></div><div><dt>最少花费</dt><dd>{adMoney(fields.minimumSpendMinor, currency, fields.monetaryBasis)}</dd></div><div><dt>试验花费上限</dt><dd>{adMoney(fields.trialSpendLimitMinor, currency, fields.monetaryBasis)}</dd></div></dl>
  </section>;
}
export function AdMutationFeedback({ mutation, title = "原操作已登记", refreshError = "" }: { mutation: Mutation; title?: string; refreshError?: string }) {
  const id = mutation.result && typeof mutation.result === "object" && "id" in mutation.result && typeof mutation.result.id === "string" ? mutation.result.id : null;
  const revision = mutation.result && typeof mutation.result === "object" && "revision" in mutation.result && typeof mutation.result.revision === "number" ? mutation.result.revision : null;
  return <>
    {mutation.error && <p className="ad-error" role="alert">{mutation.error}</p>}
    {mutation.checking && <p role="status" className="ad-note">正在核对这个账户与操作范围的本人原提交</p>}
    {mutation.frozen && !mutation.pending && <div className="ad-notice" role="status"><strong>原正文与原键已固定</strong><p>{mutation.durable ? "准备结果尚未确认 成功保存后可跨会话恢复 未确认前保留当前页副本 只重试同一原文原键或读取本人原提交" : "当前页仅重试同一笔原请求 不因响应未知另建键 关页后此填写副本不会跨会话恢复"}</p></div>}
    {mutation.reload && mutation.error && <button type="button" className="ad-secondary" disabled={mutation.pending || mutation.checking} onClick={() => void mutation.reload?.()}>重新读取此范围的本人原提交</button>}
    {mutation.canEdit && <button type="button" className="ad-secondary" onClick={mutation.reset}>修改未登记的填写</button>}
    {mutation.result !== null && <section className="ad-receipt" aria-label={title}><h3>{title}</h3>{id && <p>实际凭据 ID <code>{id}</code></p>}{revision !== null && <p>实际返回版本 V{revision}</p>}<p className="ad-note">这是本次操作实际返回的凭据 后续读取与当前状态需重新核对权限</p></section>}
    {refreshError && <p role="status" className="ad-notice">原操作已成功 后续工作区读取未完成 请重新读取 不要重复登记</p>}
  </>;
}
function useFormOperation(scope: AdCommandDraftScope, { permitted = false, onDenied, onSaved, onDirty }: FormProps) {
  const mutation = useAdCommandMutation(scope, permitted, onDenied, () => onDirty(false)), [refreshError, setRefreshError] = useState("");
  const complete = async (result: unknown) => {
    if (result === null) return;
    onDirty(false); setRefreshError("");
    try { await onSaved(); } catch { setRefreshError("refresh_failed"); }
  };
  const commandFinished = (detail: AdCommandDetail) => { onDirty(false); if (detail.status === "succeeded") void onSaved().catch(() => setRefreshError("refresh_failed")); };
  return { mutation, complete, refreshError, commandFinished };
}
export function AdGoalForm({
  scope,
  goal,
  expectedRevision,
  onSaved,
  onDirty,
  permitted = false,
  onDenied,
}: FormProps & { scope: AdProductScope; goal: AdGoalVersion | null; expectedRevision: number }) {
  const [mode, setMode] = useState(goal?.fields.mode ?? "profit_defense"),
    [error, setError] = useState("");
  const [nextRevision, setNextRevision] = useState(expectedRevision);
  const [completedRevision, setCompletedRevision] = useState<number | null>(null);
  const { mutation, complete, refreshError, commandFinished } = useFormOperation({ kind: "goal_save", accountId: scope.accountId, targetId: null, scopeKey: `product:${scope.marketplace}:${scope.currency}:${scope.asin}` }, { permitted, onDenied, onSaved, onDirty });
  const busy = mutation.pending || mutation.checking;
  const fields = goal?.fields;
  const entryBasis = adCurrencyBasis(scope.currency), inputBasis = fields ? fields.monetaryBasis : entryBasis;
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    onDirty(true);
    const data = new FormData(event.currentTarget);
    setError("");
    await complete(await mutation.submit("goals", () => {
      const val = (name: string) => String(data.get(name) ?? ""),
        money = (name: string) => adInputMinor(val(name), scope.currency),
        number = (name: string) => Number(val(name));
      const parsed = AdGoalFieldsSchema.parse({
        mode,
        effectiveFrom: val("effectiveFrom"),
        targetAcosBps: val("targetAcos") ? Math.round(number("targetAcos") * 100) : null,
        unitPriceMinor: money("unitPrice"),
        unitCostMinor: money("unitCost"),
        coreKeywords: val("coreKeywords")
          .split("\n")
          .map((v) => v.trim())
          .filter(Boolean),
        protectedTerms: val("protectedTerms")
          .split("\n")
          .map((v) => v.trim())
          .filter(Boolean),
        trialEndDate: mode === "rank_growth" ? val("trialEndDate") || null : null,
        trialSpendLimitMinor: mode === "rank_growth" ? money("trialSpendLimit") : null,
        minimumClicks: number("minimumClicks"),
        minimumPurchases: number("minimumPurchases"),
        minimumSpendMinor: money("minimumSpend") ?? 0,
        maxBidChangeBps: Math.round(number("maxBidChange") * 100),
        profitReserveBps: Math.round(number("profitReserve") * 100),
        cooldownDays: number("cooldownDays"),
        notes: val("notes"),
      });
      return AdSaveGoalInputSchema.parse({
        scope,
        expectedRevision: nextRevision,
        fields: parsed,
        idempotencyKey: adIdempotency(),
      });
    }, AdGoalVersionSchema));
  }
  if (mutation.commandId) return <AdCommandMutationPanel mutation={mutation} accountId={scope.accountId} onCompleted={detail => { if (detail.status === "succeeded" && detail.result?.version !== null && detail.result?.version !== undefined) setCompletedRevision(detail.result.version); commandFinished(detail); }} onDenied={onDenied} />;
  if (!permitted) return <><p className="ad-note">当前仅可读取目标依据 没有登记新目标版本的权限</p>{goal && <AdGoalMoneySummary goal={goal} />}</>;
  if (completedRevision !== null) return <section className="ad-receipt" aria-label="目标版本核对已完成"><h3>目标原提交已确认</h3><p>实际登记版本 V{completedRevision} 原提交不会改写为新的版本依据</p><button type="button" className="ad-secondary" onClick={() => { setNextRevision(completedRevision); setCompletedRevision(null); }}>以实际返回版本继续填写新目标</button>{refreshError && <p role="status" className="ad-notice">原目标已经登记 工作区尚未重新读取 新填写仍需核对来源与金额</p>}</section>;
  return (
    <form className="ad-form" onSubmit={submit} onChange={() => onDirty(true)}>
      <p className="ad-note">
        {scope.marketplace} · {scope.currency} · {scope.asin} · 原目标版本 V{nextRevision} · 保存后创建新的目标版本
      </p>
      {fields && <><AdMonetaryBasisNote currency={scope.currency} basis={fields.monetaryBasis} />{!fields.monetaryBasis && <details className="ad-legacy-money"><summary>核对旧目标原金额</summary><p className="ad-note">旧金额未自动带入新主单位输入 请核对真实依据后重新填写 新版本金额按固定币种精度录入</p><dl className="ad-source-fields"><div><dt>原单件售价</dt><dd>{adMoney(fields.unitPriceMinor, scope.currency)}</dd></div><div><dt>原单件成本</dt><dd>{adMoney(fields.unitCostMinor, scope.currency)}</dd></div><div><dt>原最少花费</dt><dd>{adMoney(fields.minimumSpendMinor, scope.currency)}</dd></div><div><dt>原试验上限</dt><dd>{adMoney(fields.trialSpendLimitMinor, scope.currency)}</dd></div></dl></details>}</>}
      <fieldset disabled={busy} inert={mutation.locked || !permitted} aria-disabled={mutation.locked || !permitted}>
        <p className="ad-note">{entryBasis ? `本次新版本金额以 ${scope.currency} 主单位填写 按固定 ${entryBasis.minorDigits} 位小数精确转换 不自动舍入` : `${scope.currency} 币种精度未知 暂不能转换或录入主单位金额`}</p>
        <label>
          产品目标
          <select
            aria-label="产品目标"
            value={mode}
            onChange={(e) => setMode(e.target.value as typeof mode)}
          >
            <option value="profit_defense">保利润</option>
            <option value="rank_growth">推排名</option>
          </select>
        </label>
        <div className="ad-form-grid">
          <label>
            生效日期
            <input
              name="effectiveFrom"
              type="date"
              required
              defaultValue={fields?.effectiveFrom ?? adDayNow()}
            />
          </label>
          <label>
            目标 ACoS (%)
            <input
              name="targetAcos"
              type="number"
              step="0.01"
              min="0.01"
              max="1000"
              placeholder="留空则由成本测算"
              defaultValue={fields?.targetAcosBps ? fields.targetAcosBps / 100 : ""}
            />
          </label>
        </div>
        <div className="ad-form-grid">
          <label>
            单件售价 ({scope.currency})
            <input
              name="unitPrice"
              inputMode="decimal"
              defaultValue={adMajor(fields?.unitPriceMinor ?? null, scope.currency, inputBasis)}
            />
          </label>
          <label>
            单件广告前总成本 ({scope.currency})
            <input
              name="unitCost"
              inputMode="decimal"
              defaultValue={adMajor(fields?.unitCostMinor ?? null, scope.currency, inputBasis)}
            />
          </label>
        </div>
        <p className="ad-note">
          成本包含产品、履约、平台费用等已确认成本。成本缺失时不显示盈利结论；填写目标 ACoS
          可进行受限减费试验。
        </p>
        <label>
          核心关键词（每行一个）
          <textarea
            name="coreKeywords"
            rows={3}
            defaultValue={fields?.coreKeywords.join("\n")}
            required={mode === "rank_growth"}
          />
        </label>
        {mode === "rank_growth" && (
          <div className="ad-form-grid">
            <label>
              试验结束日期
              <input
                name="trialEndDate"
                type="date"
                required
                defaultValue={fields?.trialEndDate ?? ""}
              />
            </label>
            <label>
              试验花费上限 ({scope.currency})
              <input
                name="trialSpendLimit"
                required
                inputMode="decimal"
                defaultValue={adMajor(fields?.trialSpendLimitMinor ?? null, scope.currency, inputBasis)}
              />
            </label>
          </div>
        )}
        <label>
          保护词（每行一个）
          <textarea
            name="protectedTerms"
            rows={2}
            defaultValue={fields?.protectedTerms.join("\n")}
          />
        </label>
        <details open={Boolean(fields && !fields.monetaryBasis)}>
          <summary>样本门槛与调整限制</summary>
          <div className="ad-form-grid">
            <label>
              最少点击
              <input
                name="minimumClicks"
                type="number"
                min="1"
                max="10000"
                defaultValue={fields?.minimumClicks ?? 15}
                required
              />
            </label>
            <label>
              放量最少购买量
              <input
                name="minimumPurchases"
                type="number"
                min="1"
                max="1000"
                defaultValue={fields?.minimumPurchases ?? 3}
                required
              />
            </label>
            <label>
              最少花费 ({scope.currency})
              <input
                name="minimumSpend"
                inputMode="decimal"
                defaultValue={adMajor(fields?.minimumSpendMinor ?? 1000, scope.currency, inputBasis)}
                required
              />
            </label>
            <label>
              单次竞价变化上限 (%)
              <input
                name="maxBidChange"
                type="number"
                step="0.01"
                min="0.01"
                max="50"
                defaultValue={(fields?.maxBidChangeBps ?? 1500) / 100}
                required
              />
            </label>
            <label>
              贡献利润预留比例 (%)
              <input
                name="profitReserve"
                type="number"
                min="0"
                max="90"
                defaultValue={(fields?.profitReserveBps ?? 3000) / 100}
                required
              />
            </label>
            <label>
              执行后观察天数
              <input
                name="cooldownDays"
                type="number"
                min="1"
                max="90"
                defaultValue={fields?.cooldownDays ?? 7}
                required
              />
            </label>
          </div>
        </details>
        <label>
          成本来源与目标说明
          <textarea name="notes" rows={2} maxLength={2000} defaultValue={fields?.notes} />
        </label>
      </fieldset>
      {error && (
        <p role="alert" className="ad-error">
          {error}
        </p>
      )}
      <AdMutationFeedback mutation={mutation} refreshError={refreshError} title="目标版本已登记" />
      <button className="ad-primary" disabled={busy || !permitted || mutation.result !== null} type="submit">
        {busy ? "正在核对与准备…" : mutation.frozen ? "重试保存同一笔目标原提交" : "保存目标原填写并核对"}
      </button>
    </form>
  );
}

export function AdObservationForm({
  scope,
  periodStart,
  periodEnd,
  onSaved,
  onDirty,
  permitted = false,
  onDenied,
}: FormProps & { scope: AdProductScope; periodStart: string; periodEnd: string }) {
  const [kind, setKind] = useState<AdObservationInput["kind"]>("organic_rank"),
    [error, setError] = useState("");
  const { mutation, complete, refreshError, commandFinished } = useFormOperation({ kind: "observation_record", accountId: scope.accountId, targetId: null, scopeKey: `product:${scope.marketplace}:${scope.currency}:${scope.asin}` }, { permitted, onDenied, onSaved, onDirty });
  const busy = mutation.pending || mutation.checking;
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    onDirty(true);
    const data = new FormData(e.currentTarget);
    setError("");
    await complete(await mutation.submit("observations", () => {
      const val = (k: string) => String(data.get(k) ?? ""),
        start = val("periodStart"),
        signedProfit = val("preAdContribution");
      const profit = signedProfit
        ? adInputMinor(signedProfit.replace(/^-/, ""), scope.currency)! *
          (signedProfit.startsWith("-") ? -1 : 1)
        : null;
      return AdObservationInputSchema.parse({
        scope,
        kind,
        periodStart: start,
        periodEnd: kind === "organic_rank" ? start : val("periodEnd"),
        source: val("source"),
        observedAt: new Date().toISOString(),
        keyword: kind === "organic_rank" ? val("keyword") : null,
        organicRank: kind === "organic_rank" ? Number(val("rank")) : null,
        totalSalesMinor:
          kind === "commerce" ? adInputMinor(val("totalSales"), scope.currency) : null,
        totalPurchases: kind === "commerce" ? Number(val("totalPurchases")) : null,
        preAdContributionMinor: kind === "commerce" ? profit : null,
        adsCoverageConfirmed: kind === "commerce" && data.get("adsCoverage") === "on",
        idempotencyKey: adIdempotency(),
      });
    }, AdObservationSchema));
  }
  if (mutation.commandId) return <AdCommandMutationPanel mutation={mutation} accountId={scope.accountId} onCompleted={commandFinished} onDenied={onDenied} />;
  if (!permitted) return <p className="ad-note">当前仅可读取观察证据 没有登记经营或自然排名证据的权限</p>;
  return (
    <form className="ad-form" onSubmit={submit} onChange={() => onDirty(true)}>
      <fieldset disabled={busy} inert={mutation.locked || !permitted} aria-disabled={mutation.locked || !permitted}>
        <label>
          补充证据类型
          <select value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
            <option value="organic_rank">自然排名</option>
            <option value="commerce">产品经营数据</option>
          </select>
        </label>
        <div className="ad-form-grid">
          <label>
            {kind === "organic_rank" ? "采集日期" : "统计开始日期"}
            <input
              type="date"
              name="periodStart"
              defaultValue={kind === "organic_rank" ? adDayNow() : periodStart}
              required
            />
          </label>
          {kind === "commerce" && (
            <label>
              统计结束日期
              <input type="date" name="periodEnd" defaultValue={periodEnd} required />
            </label>
          )}
        </div>
        {kind === "organic_rank" ? (
          <div className="ad-form-grid">
            <label>
              关键词
              <input name="keyword" required maxLength={200} />
            </label>
            <label>
              自然名次
              <input name="rank" type="number" min="1" max="100000" required />
            </label>
          </div>
        ) : (
          <>
            <div className="ad-form-grid">
              <label>
                总销售额 ({scope.currency})<input name="totalSales" inputMode="decimal" required />
              </label>
              <label>
                总购买量
                <input name="totalPurchases" type="number" min="0" required />
              </label>
            </div>
            <label>
              广告前贡献利润 ({scope.currency}，可留空)
              <input name="preAdContribution" inputMode="decimal" />
            </label>
            <p className="ad-note">
              需与广告统计期间和产品范围一致。总销售额用于
              TACoS；广告前贡献利润减广告花费后才显示广告后贡献利润。
            </p>
          </>
        )}
        {kind === "commerce" && (
          <label className="ad-check">
            <input name="adsCoverage" type="checkbox" />
            已核对：广告报表覆盖此产品在相同期间、币种下的完整广告花费
          </label>
        )}
        <label>
          证据来源说明
          <textarea
            name="source"
            rows={2}
            minLength={3}
            maxLength={1000}
            required
            placeholder="来源报表、采集方式与口径"
          />
        </label>
      </fieldset>
      {error && (
        <p className="ad-error" role="alert">
          {error}
        </p>
      )}
      <AdMutationFeedback mutation={mutation} refreshError={refreshError} title="观察证据已登记" />
      {(() => { const saved = AdObservationSchema.safeParse(mutation.result); return saved.success && saved.data.kind === "commerce" ? <section className="ad-observation-money" aria-label="本次观察金额依据"><AdMonetaryBasisNote currency={saved.data.scope.currency} basis={saved.data.monetaryBasis} /><p>实际登记总销售额 {adMoney(saved.data.totalSalesMinor, saved.data.scope.currency, saved.data.monetaryBasis)}</p><p>实际登记广告前贡献利润 {adMoney(saved.data.preAdContributionMinor, saved.data.scope.currency, saved.data.monetaryBasis)}</p></section> : null; })()}
      {mutation.result !== null && <button type="button" className="ad-secondary" onClick={mutation.reset}>继续登记新的观察证据</button>}
      <button className="ad-primary" type="submit" disabled={busy || !permitted || mutation.result !== null}>
        {busy ? "正在核对与准备…" : mutation.frozen ? "重试保存同一笔观察原提交" : "保存观察原填写并核对"}
      </button>
    </form>
  );
}

export function AdActionForm({
  action,
  cooldownDays = 7,
  onSaved,
  onDirty,
  permitted = false,
  onDenied,
}: FormProps & { action: AdActionView; cooldownDays?: number }) {
  const options = adNextStates[action.status],
    [status, setStatus] = useState<AdActionStatus>(options[0] ?? action.status),
    [error, setError] = useState("");
  const { mutation, complete, refreshError, commandFinished } = useFormOperation({ kind: "action_transition", accountId: action.recommendation.accountId, targetId: action.id }, { permitted, onDenied, onSaved, onDirty });
  const busy = mutation.pending || mutation.checking;
  const rec = action.recommendation;
  const dueAt = action.executedAt
    ? new Date(Date.parse(action.executedAt) + cooldownDays * 86400000)
    : null;
  const reviewNotReady = status === "reviewed" && dueAt !== null && dueAt.getTime() > Date.now();
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (reviewNotReady && !mutation.frozen) return;
    onDirty(true);
    const data = new FormData(e.currentTarget);
    setError("");
    await complete(await mutation.submit(`actions/${action.id}/events`, () => {
      const val = (k: string) => String(data.get(k) ?? "");
      if (status === "executed" && ["lower_bid", "raise_bid"].includes(rec.kind) && !rec.currency) throw new Error("原建议币种未知 请先核对来源 不能默认 USD 记录竞价");
      return AdActionEventInputSchema.parse({
        expectedRevision: action.revision,
        expectedStatus: action.status,
        status,
        reason: val("reason"),
        idempotencyKey: adIdempotency(),
        executedAt: status === "executed" ? new Date(val("executedAt")).toISOString() : null,
        actualBeforeMinor:
          status === "executed" && rec.currency ? adInputMinor(val("before"), rec.currency) : null,
        actualAfterMinor:
          status === "executed" && rec.currency ? adInputMinor(val("after"), rec.currency) : null,
        executionCampaignId: status === "executed" ? val("campaignId") || null : null,
        executionAdGroupId: status === "executed" ? val("groupId") || null : null,
        executionTargetId: status === "executed" ? val("targetId") || null : null,
      });
    }, AdActionViewSchema));
  }
  if (mutation.commandId) return <AdCommandMutationPanel mutation={mutation} accountId={action.recommendation.accountId} onCompleted={commandFinished} onDenied={onDenied} />;
  return (
    <>
      <dl className="ad-evidence">
        <dt>当前 → 建议竞价</dt>
        <dd>
          {adMoney(rec.currentBidMinor, rec.currency, rec.monetaryBasis)} →{" "}
          {adMoney(rec.proposedBidMinor, rec.currency, rec.monetaryBasis)}
        </dd>
        <dt>规则</dt>
        <dd>
          <code>{rec.ruleId}</code>
        </dd>
        <dt>统计期间</dt>
        <dd>
          {rec.periodStart} 至 {rec.periodEnd}
        </dd>
        <dt>证据</dt>
        <dd>
          {rec.evidenceKeys.length} 个事实 · 目标 {rec.goalVersionId ?? "待补充"}
        </dd>
        {action.executedAt && (
          <>
            <dt>实际执行</dt>
            <dd>
              {new Date(action.executedAt).toLocaleString("zh-CN")} ·{" "}
              {adMoney(action.actualBeforeMinor, rec.currency, rec.monetaryBasis)} →{" "}
              {adMoney(action.actualAfterMinor, rec.currency, rec.monetaryBasis)}
            </dd>
            <dt>实际执行对象</dt>
            <dd>
              活动 {action.execution?.campaignId ?? "—"} · 广告组{" "}
              {action.execution?.adGroupId ?? "—"} · 投放 {action.execution?.targetId ?? "—"}
            </dd>
          </>
        )}
      </dl>
      <AdMonetaryBasisNote currency={rec.currency} basis={rec.monetaryBasis} />
      <AdConversionSummary conversion={rec.conversion} />
      <p>{rec.reason}</p>
      <ul className="ad-constraints">
        {rec.constraints.map((c) => (
          <li key={c}>{c}</li>
        ))}
      </ul>
      {options.length > 0 && permitted && (
        <form className="ad-form" onSubmit={submit} onChange={() => onDirty(true)}>
          <fieldset disabled={busy} inert={mutation.locked} aria-disabled={mutation.locked}>
            <label>
              记录处理结果
              <select
                aria-label="记录处理结果"
                value={status}
                onChange={(e) => setStatus(e.target.value as AdActionStatus)}
              >
                {options.map((s) => (
                  <option key={s} value={s}>
                    {adStatusLabels[s]}
                  </option>
                ))}
              </select>
            </label>
            {status === "executed" && (
              <>
                <label>
                  实际执行时间
                  <input name="executedAt" type="datetime-local" step="1" required />
                </label>
                <label>
                  执行活动 ID
                  <input
                    name="campaignId"
                    defaultValue={rec.campaignId ?? ""}
                    required={!!rec.campaignId}
                  />
                </label>
                <label>
                  执行广告组 ID
                  <input
                    name="groupId"
                    defaultValue={rec.adGroupId ?? ""}
                    required={!!rec.adGroupId}
                  />
                </label>
                <label>
                  执行投放 ID
                  <input name="targetId" defaultValue={rec.targetId ?? ""} />
                </label>
                {["lower_bid", "raise_bid"].includes(rec.kind) && (
                  <div className="ad-form-grid">
                    <label>
                      核对后的原竞价
                      <input
                        name="before"
                        defaultValue={adMajor(rec.currentBidMinor, rec.currency, rec.monetaryBasis)}
                        inputMode="decimal"
                        required
                      />
                    </label>
                    <label>
                      实际新竞价
                      <input
                        name="after"
                        defaultValue={adMajor(rec.proposedBidMinor, rec.currency, rec.monetaryBasis)}
                        inputMode="decimal"
                        required
                      />
                    </label>
                  </div>
                )}
                <p className="ad-note">
                  填写已在广告后台完成的实际操作。这里记录执行结果，随后进入观察和复盘。
                  {!rec.monetaryBasis && " 原竞价精度未保存 未自动带入主单位金额 请按真实币种核对填写"}
                </p>
              </>
            )}
            <label>
              {status === "reviewed" ? "复盘结果与新报表依据" : "处理原因"}
              <textarea name="reason" minLength={3} maxLength={2000} rows={3} required />
            </label>
          </fieldset>
          {error && (
            <p role="alert" className="ad-error">
              {error}
            </p>
          )}
          {reviewNotReady && (
            <p className="ad-note">
              观察期截至 {dueAt!.toLocaleString("zh-CN")}。到期后结合新报表填写复盘结果。
            </p>
          )}
          <AdMutationFeedback mutation={mutation} refreshError={refreshError} title="处理记录已登记" />
          <button className="ad-primary" type="submit" disabled={busy || !mutation.frozen && reviewNotReady || mutation.result !== null}>
            {busy ? "正在核对与准备…" : mutation.frozen ? "重试保存同一笔处理原提交" : "保存处理原填写并核对"}
          </button>
        </form>
      )}
      <h3>处理历史</h3>
      <ol className="ad-events">
        {action.events.map((e) => (
          <li key={e.id}>
            <strong>{adStatusLabels[e.status]}</strong>
            <time>{new Date(e.at).toLocaleString("zh-CN")}</time>
            <p>{e.reason}</p>
          </li>
        ))}
      </ol>
    </>
  );
}

/** Operation scopes are entered explicitly; an operation permission does not read private history. */
export function AdIndependentForms({ accountId, canWrite, canReview, onSaved, onDirty, onDenied }: {
  accountId: string; canWrite: boolean; canReview: boolean;
} & Pick<FormProps, "onSaved" | "onDirty" | "onDenied">) {
  const [scope, setScope] = useState<AdProductScope | null>(null), [revision, setRevision] = useState(0);
  const [kind, setKind] = useState<"goal" | "observation">(canReview ? "goal" : "observation"), [error, setError] = useState("");
  if (!canWrite && !canReview) return null;
  return <section className="ad-panel ad-independent" aria-label="按明确产品范围登记">
    <header><h2>按明确产品范围登记</h2><span>操作权限不授予历史读取权限</span></header>
    <div className="ad-independent-body">
      {!scope ? <form className="ad-form" aria-label="核对登记产品范围" onChange={() => onDirty(true)} onSubmit={event => {
        event.preventDefault(); const form = new FormData(event.currentTarget);
        const parsed = AdProductScopeSchema.safeParse({ accountId, marketplace: String(form.get("marketplace") ?? ""), currency: String(form.get("currency") ?? "").trim().toUpperCase(), asin: String(form.get("asin") ?? "") });
        const version = String(form.get("revision") ?? "0");
        if (!parsed.success || !/^\d+$/.test(version) || !Number.isSafeInteger(Number(version))) { setError("请核对真实 ASIN、站点、币种和当前目标版本"); return; }
        setError(""); setRevision(Number(version)); setScope(parsed.data);
      }}>
        <div className="ad-form-grid"><label>产品 ASIN<input name="asin" required pattern="[A-Za-z0-9]{10}" maxLength={10} /></label>
          <label>产品站点<select name="marketplace" required defaultValue=""><option value="">选择实际站点</option>{AdMarketplaceSchema.options.map(value => <option key={value}>{value}</option>)}</select></label>
          <label>产品币种<input name="currency" required pattern="[A-Za-z]{3}" maxLength={3} placeholder="例如 USD" /></label>
          {canReview && <label>当前目标版本 新产品填 0<input name="revision" type="number" min="0" step="1" required defaultValue="0" /></label>}</div>
        <p className="ad-note">填写已核对的真实产品范围 已有产品的当前目标版本需自行提供 不从不可读历史猜测</p>
        {error && <p role="alert" className="ad-error">{error}</p>}
        <button type="submit" className="ad-secondary">核对产品范围</button>
      </form> : <>
        <p className="ad-scope-line"><strong>{scope.asin}</strong>{scope.marketplace} · {scope.currency}<button type="button" className="ad-link" onClick={() => {
          if (window.confirm("重新选择会清除当前页的填写副本 不会撤销已经提交的操作 若结果尚未确认请先重试原请求")) { setScope(null); onDirty(false); }
        }}>重新选择产品范围</button></p>
        <nav className="ad-drawer-tabs" aria-label="产品登记类型">
          {canReview && <button type="button" aria-pressed={kind === "goal"} onClick={() => { if (kind !== "goal" && window.confirm("切换将清除未保存的填写副本 结果未知时请先核对原请求")) { setKind("goal"); onDirty(false); } }}>登记产品目标</button>}
          {canWrite && <button type="button" aria-pressed={kind === "observation"} onClick={() => { if (kind !== "observation" && window.confirm("切换将清除未保存的填写副本 结果未知时请先核对原请求")) { setKind("observation"); onDirty(false); } }}>登记经营或自然排名证据</button>}
        </nav>
        {kind === "goal" && canReview ? <AdGoalForm scope={scope} expectedRevision={revision} goal={null} permitted onSaved={onSaved} onDirty={onDirty} onDenied={onDenied} />
          : canWrite ? <AdObservationForm scope={scope} periodStart={adDayNow()} periodEnd={adDayNow()} permitted onSaved={onSaved} onDirty={onDirty} onDenied={onDenied} /> : null}
      </>}
    </div>
  </section>;
}

export function AdArchiveForm({ accountId, importId, permitted = false, onSaved, onDirty, onDenied }: FormProps & { accountId: string; importId: string }) {
  const { mutation, complete, refreshError, commandFinished } = useFormOperation({ kind: "import_archive", accountId, targetId: importId }, { permitted, onSaved, onDirty, onDenied });
  if (mutation.commandId) return <AdCommandMutationPanel mutation={mutation} accountId={accountId} onCompleted={commandFinished} onDenied={onDenied} />;
  if (!permitted) return null;
  return <form className="ad-form" aria-label={`归档来源 ${importId}`} onChange={() => onDirty(true)} onSubmit={event => {
    event.preventDefault(); const form = new FormData(event.currentTarget); onDirty(true);
    void mutation.submit(`imports/${importId}/archive`, () => AdArchiveInputSchema.parse({ reason: String(form.get("reason") ?? ""), idempotencyKey: adIdempotency() }), AdImportViewSchema).then(complete);
  }}><fieldset disabled={mutation.pending || mutation.checking} inert={mutation.locked} aria-disabled={mutation.locked}><label>归档原因<textarea name="reason" minLength={3} maxLength={1000} rows={3} required /></label></fieldset>
    <p className="ad-note">归档后不参与新分析 待执行建议会过期 原始来源与已封存历史仍保留</p>
    <AdMutationFeedback mutation={mutation} title="原来源已归档" refreshError={refreshError} />
    <button type="submit" className="ad-secondary" disabled={mutation.pending || mutation.checking || mutation.result !== null}>{mutation.pending ? "正在准备…" : mutation.frozen ? "重试保存同一笔归档原提交" : "保存归档原填写并核对"}</button>
  </form>;
}
