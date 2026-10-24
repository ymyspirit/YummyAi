"use client";
import { flushSync } from "react-dom";
import { cancelViewTransitions, observeViewTransition } from "../navigation/view-transition";
export function manufacturingTransition(change: () => void) {
  cancelViewTransitions();
  if (!document.startViewTransition || window.matchMedia("(prefers-reduced-motion: reduce)").matches) { change(); return; }
  observeViewTransition(document.startViewTransition(() => flushSync(change)));
}
