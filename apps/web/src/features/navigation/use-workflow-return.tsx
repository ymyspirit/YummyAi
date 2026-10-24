"use client";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { useSyncExternalStore } from "react";
import { returnHref, workflowHref } from "./workflow-href";
import "./workflow-navigation.css";

function subscribeLocation(onChange: () => void) {
  window.addEventListener("hashchange", onChange);
  window.addEventListener("popstate", onChange);
  return () => {
    window.removeEventListener("hashchange", onChange);
    window.removeEventListener("popstate", onChange);
  };
}
function browserLocation() {
  const { pathname, search, hash } = window.location;
  const query = new URLSearchParams(search).toString();
  return `${pathname}${query ? `?${query}` : ""}${hash}`;
}
const serverLocation = () => "";

export function useWorkflowReturn() {
  const pathname = usePathname(),
    params = useSearchParams();
  const route = `${pathname ?? ""}${params?.size ? `?${params}` : ""}`;
  const location = useSyncExternalStore(subscribeLocation, browserLocation, serverLocation);
  const fragmentAt = location.indexOf("#");
  // A route transition must never borrow the previous page's fragment. The
  // server snapshot omits it until hydration reads this browser's exact route.
  const hash = fragmentAt >= 0 && location.slice(0, fragmentAt) === route ? location.slice(fragmentAt) : "";
  const current = `${route}${hash}`;
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
