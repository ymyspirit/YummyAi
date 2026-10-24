"use client";

// Adapted from React Bits SpotlightCard by David Haz.
// https://github.com/DavidHDev/react-bits/tree/main/src/ts-default/Components/SpotlightCard
// MIT + Commons Clause; see LICENSE.md in this directory.
import { useRef, type CSSProperties, type PropsWithChildren } from "react";

import "./spotlight-card.css";

export function SpotlightCard({ children, className = "", spotlightColor = "rgba(37, 99, 235, 0.08)" }:
  PropsWithChildren<{ className?: string; spotlightColor?: `rgba(${number}, ${number}, ${number}, ${number})` }>) {
  const ref = useRef<HTMLDivElement>(null);
  return <div ref={ref} className={`rb-spotlight ${className}`}
    style={{ "--spotlight-color": spotlightColor } as CSSProperties}
    onPointerMove={(event) => {
      if (event.pointerType !== "mouse" || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
      const element = ref.current;
      if (!element) return;
      const rect = element.getBoundingClientRect();
      element.style.setProperty("--mouse-x", `${event.clientX - rect.left}px`);
      element.style.setProperty("--mouse-y", `${event.clientY - rect.top}px`);
    }}>
    {children}
  </div>;
}
