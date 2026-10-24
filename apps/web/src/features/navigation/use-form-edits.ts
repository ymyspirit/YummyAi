"use client";

import { useCallback, useLayoutEffect, useRef, useState } from "react";

export function formFingerprint(form: HTMLFormElement) {
  return JSON.stringify(
    [...form.querySelectorAll("input, textarea, select")].map((element) => {
      const input = element as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
      if (input instanceof HTMLInputElement && ["submit", "button", "reset"].includes(input.type))
        return null;
      return [
        input.name,
        input.value,
        input instanceof HTMLInputElement ? input.checked : null,
        input instanceof HTMLSelectElement
          ? [...input.selectedOptions].map((option) => option.value)
          : null,
        input instanceof HTMLInputElement && input.files
          ? [...input.files].map((file) => [file.name, file.size, file.lastModified])
          : null,
      ];
    }),
  );
}

/** Tracks independent forms so saving one cannot silently discard another. */
export function useFormEdits() {
  const ref = useRef<HTMLElement>(null);
  const baselines = useRef(new Map<HTMLFormElement, string>());
  const [dirty, setDirty] = useState(false);
  const check = useCallback(() => {
    ref.current?.querySelectorAll("form").forEach(form => {
      if (!baselines.current.has(form)) baselines.current.set(form, formFingerprint(form));
    });
    for (const form of baselines.current.keys()) {
      if (!ref.current?.contains(form)) baselines.current.delete(form);
    }
    const changed = [...baselines.current].some(([form, saved]) => formFingerprint(form) !== saved);
    setDirty(changed);
    return changed;
  }, []);
  useLayoutEffect(() => {
    ref.current?.querySelectorAll("form").forEach((form) => {
      if (!baselines.current.has(form)) baselines.current.set(form, formFingerprint(form));
    });
    check();
  });
  const commit = useCallback(
    (form: HTMLFormElement, submitted: string) => {
      baselines.current.set(form, submitted);
      return check();
    },
    [check],
  );
  return { ref, dirty, check, commit };
}
