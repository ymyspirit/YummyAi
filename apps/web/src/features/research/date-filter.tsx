"use client";

import { CalendarDays } from "lucide-react";
import { useRef } from "react";

export function DateFilter({
  defaultValue,
  label,
  name,
}: {
  defaultValue: string;
  label: string;
  name: "dateFrom" | "dateTo";
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const inputId = `filter-${name}`;

  function openPicker() {
    const input = inputRef.current;
    if (!input) return;
    input.focus();
    try {
      input.showPicker?.();
    } catch {
      // Focus remains available for browsers without a programmatic date picker.
    }
  }

  return (
    <div className="date-filter">
      <label htmlFor={inputId}>{label}</label>
      <span className="date-filter-control">
        <input ref={inputRef} id={inputId} name={name} type="date" defaultValue={defaultValue} />
        <button
          type="button"
          aria-label={`打开${label}选择器`}
          title={`打开${label}选择器`}
          onClick={openPicker}
        >
          <CalendarDays size={15} aria-hidden="true" />
        </button>
      </span>
    </div>
  );
}
