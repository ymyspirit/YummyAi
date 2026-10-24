"use client";
import { useCallback, useState } from "react";
import type { OrderCenterOptions, OrderWorkspaceModule } from "@yummyai/contracts/order/workspace";
import { type OrderReviewState } from "./order-work-detail";
import { OrderWholeDetailPanel } from "./order-whole-detail-panel";
import { centers } from "./order-center-model";
import { TaskDrawer } from "../navigation/task-drawer";

export function OrderReviewDrawer({
  id,
  queue,
  options,
  onSelect,
  onClose,
  onChanged,
  module = "orders",
  editorOpen = false,
  onEditor = () => {},
  onSelectItem,
  queueOrderIds = {},
}: {
  id: string;
  queue: string[];
  options: OrderCenterOptions | null;
  onSelect: (id: string) => void;
  onClose: () => void;
  onChanged: () => void;
  module?: OrderWorkspaceModule;
  editorOpen?: boolean;
  onEditor?: (open: boolean) => void;
  onModuleChange?: (module: OrderWorkspaceModule) => void;
  operatorFlow?: boolean;
  onSelectItem?: (id: string, module: OrderWorkspaceModule) => void;
  queueOrderIds?: Record<string, string>;
}) {
  const [state, setState] = useState<OrderReviewState>({
    dirty: false,
    busy: false,
    loading: true,
  });
  const [orderId, setOrderId] = useState<string | null>(null);
  const orderLoaded = useCallback((value: string) => setOrderId(value), []);
  const index = queue.findIndex(lineId => lineId === id || !!orderId && queueOrderIds[lineId] === orderId);
  const previous = index > 0 ? queue[index - 1] : undefined;
  const next = index >= 0 ? queue[index + 1] : undefined;
  function leave(action: () => void) {
    if (state.busy || (state.dirty && !window.confirm("有未保存的修改，确定放弃修改并切换？")))
      return;
    action();
  }
  function select(nextId: string) {
    setState({ dirty: false, busy: false, loading: true });
    onSelect(nextId);
  }
  return (
    <TaskDrawer
      className="oc-review-drawer"
      contentOwnsScroll
      fullScreen={editorOpen}
      title="整单详情"
      description={index >= 0 ? `本页第 ${index + 1} 单 / 共 ${queue.length} 单` : "订单详情"}
      recordKey={`${orderId ?? id}:${module}`}
      state={state}
      onClose={onClose}
      closeLabel={`返回${centers[module].title}`}
      previous={{ label: "上一单", action: previous ? () => select(previous) : undefined }}
      next={{ label: "下一单", action: next ? () => select(next) : undefined }}
    >
      <OrderWholeDetailPanel
        id={id}
        module={module}
        options={options}
        editorOpen={editorOpen}
        onClose={onClose}
        onEditor={onEditor}
        onChanged={onChanged}
        onOrderLoaded={orderLoaded}
        onStateChange={setState}
        onSelectItem={(lineId, target) => {
          if (lineId === id && target === module) return;
          leave(() => {
            setState({ dirty: false, busy: false, loading: true });
            onSelectItem?.(lineId, target);
          });
        }}
        review={{
          hasNext: !!next,
          onNext: () => leave(() => (next ? select(next) : onClose())),
        }}
      />
    </TaskDrawer>
  );
}
