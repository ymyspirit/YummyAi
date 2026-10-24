"use client";
import { useEffect, useState, useId } from "react";
import { TeamOptionsSchema } from "@yummyai/contracts/identity/teams";
export function TeamSelect({
  initialValue = "",
  onChange,
  disabled = false,
}: {
  initialValue?: string;
  onChange?: (value: string) => void;
  disabled?: boolean;
}) {
  const help = useId();
  const [options, setOptions] = useState<Array<{ id: string; name: string }>>([]),
    [value, setValue] = useState(initialValue),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(true);
  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    void (async () => {
      try {
        const response = await fetch("/api/teams/options", {
          cache: "no-store",
          signal: controller.signal,
        });
        if (!response.ok) throw Error("团队选项暂不可用 请刷新核对");
        const result = TeamOptionsSchema.parse(await response.json());
        if (active) setOptions(result);
      } catch {
        if (active && !controller.signal.aborted) setError("团队选项暂不可用 请刷新核对");
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
      controller.abort();
    };
  }, []);
  return (
    <label>
      <span>所属团队</span>
      <select
        aria-label="所属团队"
        aria-describedby={help}
        name="teamId"
        value={value}
        disabled={disabled || loading || Boolean(error)}
        onChange={(event) => {
          setValue(event.target.value);
          onChange?.(event.target.value);
        }}
      >
        <option value="">未分配团队</option>
        {initialValue && !options.some((team) => team.id === initialValue) ? (
          <option value={initialValue}>原团队 当前不可选择</option>
        ) : null}
        {options.map((team) => (
          <option key={team.id} value={team.id}>
            {team.name}
          </option>
        ))}
      </select>
      {loading ? (
        <small id={help} role="status">
          正在读取团队
        </small>
      ) : error ? (
        <small id={help} role="status">
          {error}
        </small>
      ) : (
        <small id={help}>未分配的记录按本人或公司权限读取</small>
      )}
    </label>
  );
}
