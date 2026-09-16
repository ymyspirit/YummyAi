"use client";
import { useEffect, useLayoutEffect, type ReactNode } from "react";
import { useFormEdits } from "../navigation/use-form-edits";
import type { TaskDrawerState } from "../navigation/task-drawer";

/** Also observes add/remove controls, whose changes need not fire an input event. */
export function DevelopmentDrawerForm({
  children,
  busy,
  onStateChange,
}: {
  children: ReactNode;
  busy: boolean;
  onStateChange: (state: TaskDrawerState) => void;
}) {
  const { ref, dirty, check } = useFormEdits();
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new MutationObserver(check);
    observer.observe(element, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [ref, check]);
  useEffect(() => onStateChange({ dirty, busy, loading: false }), [dirty, busy, onStateChange]);
  // Read after child onChange handlers, so tracking cannot restore a controlled
  // input's old value before the child has consumed the input event.
  return (
    <section ref={ref} onChange={check}>
      {children}
    </section>
  );
}
