"use client";
import { useState } from "react";
import type { OrderCenterOptions, OrderWorkspaceModule } from "@yummyai/contracts/order/workspace";
import { OrderWorkDetailPanel, type OrderReviewState } from "./order-work-detail";
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
  onModuleChange,
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
}) {
  const [state, setState] = useState<OrderReviewState>({
    dirty: false,
    busy: false,
    loading: true,
  });
  const index = queue.indexOf(id);
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
      title={module === "orders" ? "连续审单" : `${centers[module].title} · 连续处理`}
      description={index >= 0 ? `本页 ${index + 1} / ${queue.length}` : "订单详情"}
      recordKey={`${id}:${module}`}
      state={state}
      onClose={onClose}
      closeLabel={`返回${centers[module].title}`}
      previous={{ label: "上一单", action: previous ? () => select(previous) : undefined }}
      next={{ label: "下一单", action: next ? () => select(next) : undefined }}
    >
      <OrderWorkDetailPanel
        key={`${id}:${module}`}
        id={id}
        module={module}
        options={options}
        editorOpen={editorOpen}
        onBack={onClose}
        onEditor={onEditor}
        onChanged={onChanged}
        onModuleChange={
          onModuleChange
            ? (target) => {
                if (target === module) return;
                leave(() => {
                  setState({ dirty: false, busy: false, loading: true });
                  onModuleChange(target);
                });
              }
            : undefined
        }
        review={{
          hasNext: !!next,
          onStateChange: setState,
          onNext: () => leave(() => (next ? select(next) : onClose())),
          onSavedNext: () => (next ? select(next) : onClose()),
        }}
      />
    </TaskDrawer>
  );
}
