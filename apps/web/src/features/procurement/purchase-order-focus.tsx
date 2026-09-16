"use client";
import { useEffect } from "react";

export function PurchaseOrderFocus({ id, found }: { id?: string; found: boolean }) {
  useEffect(() => {
    if (!id || !found) return;
    const row = document.getElementById(`purchase-${id}`);
    row?.scrollIntoView({ block: "center" });
    row?.focus({ preventScroll: true });
  }, [id, found]);
  if (!id) return null;
  return (
    <p className="record-notice" role={found ? "status" : "alert"}>
      {found
        ? "已定位来源采购单，可在该行编辑、审核或登记收货。"
        : "当前工作区未找到指定采购单，请核对编号和访问权限。"}
    </p>
  );
}
