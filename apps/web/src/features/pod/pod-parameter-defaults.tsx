"use client";
import { createContext, useContext, type ComponentProps, type ReactNode } from "react";

type Values = Record<string, string | number | boolean>;
const Defaults = createContext<Values>({});
export function podParameterFormDefaults(
  snapshot: Record<string, unknown> | null | undefined,
): Values {
  const result: Values = {};
  for (const [key, value] of Object.entries(snapshot ?? {})) {
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean")
      result[key] = value;
    else if (Array.isArray(value) && value.every((item) => typeof item === "string"))
      result[key] = value.join("\n");
  }
  if (typeof snapshot?.minimumConfidence === "number")
    result.minimumConfidence = snapshot.minimumConfidence * 100;
  return result;
}
export function PodParameterDefaults({
  values,
  children,
}: {
  values?: Record<string, unknown> | null;
  children: ReactNode;
}) {
  return <Defaults.Provider value={podParameterFormDefaults(values)}>{children}</Defaults.Provider>;
}
export function ParameterInput(props: ComponentProps<"input">) {
  const defaults = useContext(Defaults),
    value = props.name ? defaults[props.name] : undefined;
  if (props.value !== undefined || props.checked !== undefined) return <input {...props} />;
  if (props.type === "checkbox")
    return (
      <input
        {...props}
        defaultChecked={typeof value === "boolean" ? value : props.defaultChecked}
      />
    );
  return (
    <input
      {...props}
      defaultValue={
        typeof value === "string" || typeof value === "number" ? value : props.defaultValue
      }
    />
  );
}
export function ParameterSelect(props: ComponentProps<"select">) {
  const defaults = useContext(Defaults),
    value = props.name ? defaults[props.name] : undefined;
  return (
    <select
      {...props}
      defaultValue={
        typeof value === "string" || typeof value === "number" ? value : props.defaultValue
      }
    />
  );
}
export function ParameterTextArea(props: ComponentProps<"textarea">) {
  const defaults = useContext(Defaults),
    value = props.name ? defaults[props.name] : undefined;
  return (
    <textarea
      {...props}
      defaultValue={
        typeof value === "string" || typeof value === "number" ? value : props.defaultValue
      }
    />
  );
}
