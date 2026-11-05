"use client";
import { useState } from "react";
import {
  SaveLogisticsRuleSchema,
  type LogisticsConnectionView,
} from "@yummyai/contracts/logistics";

export function LogisticsRuleForm({
  connection,
  busy,
  onDirty,
  onSave,
}: {
  connection: LogisticsConnectionView;
  busy: boolean;
  onDirty(): void;
  onSave(input: unknown): Promise<void>;
}) {
  const rule = connection.rule,
    digits = connection.profile.minorUnitDigits,
    factor = 10 ** digits;
  const [mode, setMode] = useState(
    rule?.maxTicketMinor === null && rule.maxDailyMinor === null ? "per_item" : "total",
  );
  const [error, setError] = useState("");
  function amount(value: FormDataEntryValue | null) {
    const text = String(value ?? "").trim();
    if (!/^\d+(?:\.\d+)?$/.test(text)) throw new Error("请填写有效金额");
    const [whole, fraction = ""] = text.split(".");
    if (fraction.length > digits) throw new Error(`当前币种最多填写 ${digits} 位小数`);
    const result = Number(
      BigInt(whole!) * BigInt(factor) + BigInt(fraction.padEnd(digits, "0") || "0"),
    );
    if (!Number.isSafeInteger(result) || result <= 0) throw new Error("金额须大于零且在可用范围内");
    return result;
  }
  return (
    <form
      className="logistics-form"
      onChange={onDirty}
      onSubmit={(event) => {
        event.preventDefault();
        setError("");
        const data = new FormData(event.currentTarget);
        try {
          const perItem = String(data.get("perItem") ?? "").trim();
          const input = SaveLogisticsRuleSchema.omit({ idempotencyKey: true }).parse({
            connectionId: connection.id,
            expectedVersion: connection.ruleVersion,
            rule: {
              name: String(data.get("ruleName")),
              currency: connection.profile.currency,
              autoPurchase: data.get("auto") === "on",
              maxTicketMinor: mode === "per_item" ? null : amount(data.get("ticket")),
              maxDailyMinor: mode === "per_item" ? null : amount(data.get("daily")),
              ...(perItem ? { maxPerItemMinor: amount(perItem) } : {}),
              quoteMaxAgeSeconds: 120,
              allowedChannelCodes:
                rule?.allowedChannelCodes ??
                connection.profile.channels.map((channel) => channel.code),
              evidence: String(data.get("evidence")),
            },
          });
          void onSave(input);
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : "费用规则填写不完整");
        }
      }}
    >
      <fieldset className="logistics-fields" disabled={busy}>
        <legend>共用购单费用规则 · {connection.profile.currency}</legend>
        <label>
          规则名称
          <input name="ruleName" required defaultValue={rule?.name} />
        </label>
        <label>
          费用控制
          <select
            aria-label="费用控制"
            value={mode}
            onChange={(event) => setMode(event.target.value)}
          >
            <option value="total">设置单票与每日上限</option>
            <option value="per_item">只按平均每件运费拦截 不设总额上限</option>
          </select>
        </label>
        {mode === "total" && (
          <>
            <label>
              单票费用上限（{connection.profile.currency}）
              <input
                name="ticket"
                required
                inputMode="decimal"
                defaultValue={rule?.maxTicketMinor ? rule.maxTicketMinor / factor : ""}
              />
            </label>
            <label>
              每日费用上限（{connection.profile.currency}）
              <input
                name="daily"
                required
                inputMode="decimal"
                defaultValue={rule?.maxDailyMinor ? rule.maxDailyMinor / factor : ""}
              />
            </label>
          </>
        )}
        <label>
          平均每件运费异常阈值（{connection.profile.currency}）
          <input
            name="perItem"
            required={mode === "per_item"}
            inputMode="decimal"
            defaultValue={rule?.maxPerItemMinor ? rule.maxPerItemMinor / factor : ""}
          />
        </label>
        <p className="oc-muted logistics-wide">
          整单运费 ÷ 商品总件数 超过阈值转异常且不购单 等于阈值可继续 系统始终先检查尺寸、国家和时效
          再选合规最低价
        </p>
        <label className="logistics-wide">
          费用授权依据
          <input name="evidence" required minLength={5} defaultValue={rule?.evidence} />
        </label>
        <label className="logistics-check">
          <input
            name="auto"
            type="checkbox"
            defaultChecked={rule?.autoPurchase ?? false}
            disabled={!connection.verifiedAt}
          />
          启用已核验账户自动购单
        </label>
        {error && (
          <p role="alert" className="logistics-error logistics-wide">
            {error}
          </p>
        )}
        <button className="oc-button" disabled={busy || !connection.profile.channels.length}>
          保存费用规则
        </button>
      </fieldset>
    </form>
  );
}
