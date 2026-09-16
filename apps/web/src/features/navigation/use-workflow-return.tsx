"use client";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { returnHref, workflowHref } from "./workflow-href";
import "./workflow-navigation.css";

export function useWorkflowReturn() {
  const pathname = usePathname(),
    params = useSearchParams();
  const current = `${pathname ?? ""}${params?.size ? `?${params}` : ""}`;
  const back = returnHref(params?.get("returnTo"));
  return { back, current, link: (target: string) => workflowHref(target, back ?? current) };
}

export function WorkflowReturnLink({
  label = "返回来源页面",
  className,
}: {
  label?: string;
  className?: string;
}) {
  const { back } = useWorkflowReturn();
  return back ? (
    <Link className={className} href={back}>
      {label}
    </Link>
  ) : null;
}
