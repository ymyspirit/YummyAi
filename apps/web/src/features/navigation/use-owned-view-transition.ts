"use client";
import { useEffect, useState } from "react";
import { flushSync } from "react-dom";
import { observeViewTransition } from "./view-transition";
type Driver = {
  animated: () => boolean;
  start: (update: () => void) => ViewTransition;
  commit: (update: () => void) => void;
};
export function createOwnedViewTransitions(
  driver: Driver = {
    animated: () =>
      Boolean(document.startViewTransition) &&
      !window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    start: (update) => document.startViewTransition(update),
    commit: flushSync,
  },
) {
  let current: ViewTransition | null = null,
    generation = 0;
  const cancel = () => {
    generation++;
    current?.skipTransition();
    current = null;
  };
  const change = (update: () => void) => {
    current?.skipTransition();
    current = null;
    const key = generation;
    if (!driver.animated()) {
      update();
      return;
    }
    current = observeViewTransition(
      driver.start(() => {
        if (key === generation) driver.commit(update);
      }),
    );
  };
  return { change, cancel };
}
/** Explicit cancellation also invalidates browser-held private updates. */
export function useOwnedViewTransition() {
  const [controller] = useState(() => createOwnedViewTransitions());
  useEffect(() => controller.cancel, [controller]);
  return controller;
}
