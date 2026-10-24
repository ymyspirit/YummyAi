"use client";
import { useCallback, useEffect, useState } from "react";
import "./order-line-responsibility.css";
import {
  OrderLineResponsibilityInputSchema,
  OrderLineResponsibilityViewSchema,
} from "@yummyai/contracts/order/responsibility";
import {
  ResponsibilityPanel,
  type ResponsibilitySaveInput,
} from "../responsibility/responsibility-panel";

const reasons = [
  { value: "initial_assignment", label: "首次安排" },
  { value: "handoff", label: "责任交接" },
  { value: "deadline_update", label: "调整内部截止" },
  { value: "correction", label: "纠正安排" },
];
class ResponsibilityRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
async function request(
  lineId: string,
  search: string,
  signal?: AbortSignal,
  input?: ResponsibilitySaveInput,
) {
  const body = input ? OrderLineResponsibilityInputSchema.safeParse(input) : undefined;
  if (body && !body.success)
    throw new ResponsibilityRequestError(400, "请核对负责人、截止、升级与调整原因");
  const response = await fetch(
    `/api/order-centers/lines/${lineId}/responsibility${!input && search ? "?q=" + encodeURIComponent(search) : ""}`,
    {
      cache: "no-store",
      signal,
      ...(body?.success
        ? {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body.data),
          }
        : {}),
    },
  );
  const value = await response.json().catch(() => null);
  if (!response.ok)
    throw new ResponsibilityRequestError(
      response.status,
      response.status === 404
        ? "本件跟进安排暂未启用或资料不可用"
        : typeof value?.message === "string"
          ? value.message
          : "责任安排暂时无法读取",
    );
  const parsed = OrderLineResponsibilityViewSchema.safeParse(value);
  if (!parsed.success) throw new ResponsibilityRequestError(502, "责任安排返回不完整 请刷新核对");
  return parsed.data;
}
export function OrderLineResponsibilityPanel({
  lineId,
  disabled,
  onBusyChange,
}: {
  lineId: string;
  disabled: boolean;
  onBusyChange?(busy: boolean): void;
}) {
  const [open, setOpen] = useState(false);
  const [present, setPresent] = useState(false);
  useEffect(() => {
    if (open) {
      setPresent(true);
      return;
    }
    const timer = setTimeout(
      () => setPresent(false),
      window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 160,
    );
    return () => clearTimeout(timer);
  }, [open]);
  const read = useCallback(
    (search: string, signal: AbortSignal) => request(lineId, search, signal),
    [lineId],
  );
  const save = useCallback(
    async (input: ResponsibilitySaveInput) => ({
      status: "success" as const,
      message: "跟进安排已保存",
      data: await request(lineId, "", undefined, input),
    }),
    [lineId],
  );
  return (
    <details
      className="order-line-responsibility"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>本件履约跟进安排</summary>
      {present ? (
        <ResponsibilityPanel
          key={lineId}
          recordKey={"order-line:" + lineId}
          revision={0}
          disabled={disabled}
          read={read}
          save={save}
          onBusyChange={onBusyChange}
          reasonOptions={reasons}
          title="本件履约跟进"
          drawerTitle="安排本件履约跟进"
          regionLabel="本件责任与时限"
        />
      ) : null}
    </details>
  );
}
