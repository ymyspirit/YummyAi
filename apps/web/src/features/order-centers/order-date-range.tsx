"use client";
import { useEffect, useRef, useState } from "react";
import { CalendarDays, ChevronLeft, ChevronRight } from "lucide-react";

const iso = (date: Date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
export function OrderDateRange({ from = "", to = "" }: { from?: string; to?: string }) {
  const [start, setStart] = useState(from),
    [end, setEnd] = useState(to);
  const [month, setMonth] = useState(() => new Date(`${from || iso(new Date())}T12:00:00`));
  const picker = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const dismiss = (event: PointerEvent) => {
      if (picker.current && !picker.current.contains(event.target as Node))
        picker.current.open = false;
    };
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, []);
  function choose(value: string) {
    if (!start || end) {
      setStart(value);
      setEnd("");
    } else {
      setStart(value < start ? value : start);
      setEnd(value < start ? start : value);
    }
  }
  function preset(days: number, yesterday = false) {
    const last = new Date();
    if (yesterday) last.setDate(last.getDate() - 1);
    const first = new Date(last);
    first.setDate(first.getDate() - days + 1);
    setStart(iso(first));
    setEnd(iso(last));
    setMonth(first);
    if (picker.current) picker.current.open = false;
  }
  return (
    <div className="oc-date-range">
      <input type="hidden" name="from" value={start} />
      <input type="hidden" name="to" value={end} />
      <span className="oc-control-label">日期范围</span>
      <details
        ref={picker}
        className="oc-date-picker"
        onKeyDown={(event) => {
          if (event.key === "Escape" && picker.current) {
            picker.current.open = false;
            picker.current.querySelector("summary")?.focus();
          }
        }}
      >
        <summary aria-label="选择日期范围">
          <CalendarDays size={15} />
          <span>
            {start || "开始日期"} 至 {end || "结束日期"}
          </span>
        </summary>
        <div className="oc-calendar-popover" role="group" aria-label="日期范围选择器">
          <div className="oc-date-presets">
            <button type="button" onClick={() => preset(1)}>
              今天
            </button>
            <button type="button" onClick={() => preset(1, true)}>
              昨天
            </button>
            <button type="button" onClick={() => preset(7)}>
              近 7 天
            </button>
            <button type="button" onClick={() => preset(30)}>
              近 30 天
            </button>
            <button
              type="button"
              onClick={() => {
                setStart("");
                setEnd("");
              }}
            >
              不限日期
            </button>
          </div>
          <div className="oc-calendar-months">
            {[0, 1].map((offset) => {
              const first = new Date(month.getFullYear(), month.getMonth() + offset, 1);
              const leading = (first.getDay() + 6) % 7;
              const days = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
              return (
                <div className="oc-calendar-month" key={offset}>
                  <div className="oc-calendar-heading">
                    {offset === 0 ? (
                      <button
                        type="button"
                        aria-label="上个月"
                        onClick={() =>
                          setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))
                        }
                      >
                        <ChevronLeft size={16} />
                      </button>
                    ) : (
                      <span />
                    )}
                    <strong>
                      {first.getFullYear()} 年 {first.getMonth() + 1} 月
                    </strong>
                    <button
                      type="button"
                      className={offset === 0 ? "oc-next-mobile" : undefined}
                      aria-label={offset === 0 ? "下个月（单月）" : "下个月"}
                      onClick={() =>
                        setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))
                      }
                    >
                      <ChevronRight size={16} />
                    </button>
                  </div>
                  <div className="oc-calendar-grid">
                    {["一", "二", "三", "四", "五", "六", "日"].map((day) => (
                      <span key={day}>{day}</span>
                    ))}
                    {Array.from({ length: leading }, (_, i) => (
                      <span key={`blank-${i}`} />
                    ))}
                    {Array.from({ length: days }, (_, i) => {
                      const value = iso(new Date(first.getFullYear(), first.getMonth(), i + 1));
                      const selected = value === start || value === end;
                      return (
                        <button
                          type="button"
                          key={value}
                          aria-label={value}
                          aria-pressed={selected}
                          className={
                            selected
                              ? "selected"
                              : start && end && value > start && value < end
                                ? "in-range"
                                : ""
                          }
                          onClick={() => choose(value)}
                        >
                          {i + 1}
                        </button>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
          <div className="oc-date-manual">
            <label>
              开始日期
              <input type="date" value={start} onChange={(event) => setStart(event.target.value)} />
            </label>
            <label>
              结束日期
              <input
                type="date"
                value={end}
                min={start || undefined}
                onChange={(event) => setEnd(event.target.value)}
              />
            </label>
            <button
              type="button"
              className="oc-button"
              onClick={() => {
                if (picker.current) picker.current.open = false;
              }}
            >
              完成
            </button>
          </div>
          <p className="oc-hint">
            按{Intl.DateTimeFormat().resolvedOptions().timeZone}查询，包含结束日期当天。
          </p>
        </div>
      </details>
    </div>
  );
}
