"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { SalesPlanPackageView } from "@yummyai/contracts/catalog/sales-plan-delivery";

/** Keep private failures in the workbench and cancel an old object's pending download. */
export function useSalesPackageDownload(onError: (message: string) => void) {
  const controllers = useRef(new Set<AbortController>());
  const [pending, setPending] = useState<string | null>(null);
  const errorCallback = useRef(onError);
  errorCallback.current = onError;
  const cancel = useCallback(() => {
    for (const controller of controllers.current) controller.abort();
    controllers.current.clear();
    setPending(null);
  }, []);
  useEffect(
    () => () => {
      for (const controller of controllers.current) controller.abort();
      controllers.current.clear();
    },
    [],
  );
  async function download(pack: SalesPlanPackageView) {
    if (controllers.current.size) return;
    const controller = new AbortController();
    controllers.current.add(controller);
    setPending(pack.id);
    errorCallback.current("");
    try {
      const response = await fetch(pack.downloadPath, {
        cache: "no-store",
        credentials: "same-origin",
        signal: controller.signal,
      });
      if (!response.ok) {
        const error = await response.json().catch(() => null);
        throw Error(
          typeof error?.message === "string"
            ? error.message
            : "资料包暂时无法下载 请重新核对当前权限与原文件",
        );
      }
      if (!response.headers.get("content-type")?.startsWith("application/zip"))
        throw Error("下载响应不是资料包 请重试核对");
      const blob = await response.blob();
      const signature = new Uint8Array(await blob.slice(0, 4).arrayBuffer());
      if (
        signature.length !== 4 ||
        signature[0] !== 0x50 ||
        signature[1] !== 0x4b ||
        signature[2] !== 3 ||
        signature[3] !== 4
      )
        throw Error("资料包响应不完整 请重试下载");
      if (controller.signal.aborted) return;
      const url = URL.createObjectURL(blob),
        anchor = document.createElement("a");
      try {
        anchor.href = url;
        anchor.download = `${pack.downloadPath.includes("basis=history") ? "historical-" : ""}sales-package-${pack.id}.zip`;
        document.body.append(anchor);
        anchor.click();
      } finally {
        anchor.remove();
        URL.revokeObjectURL(url);
      }
    } catch (error) {
      if (!controller.signal.aborted)
        errorCallback.current(error instanceof Error ? error.message : "资料包下载失败 请重试");
    } finally {
      controllers.current.delete(controller);
      if (!controller.signal.aborted) setPending(null);
    }
  }
  return { download, pending, cancel };
}
