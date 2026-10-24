"use client";
import { EntityIdSchema } from "@yummyai/contracts/common/ids";
import {
  CaptureMediaPageSchema,
  type CaptureMediaPage,
} from "@yummyai/contracts/capture/media-preview";
import { useCallback, useEffect, useRef, useState } from "react";

export class CaptureMediaReadError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
export function captureMediaHref(snapshotId: string, mediaId: string, revision = 0) {
  return `/api/capture-media/${EntityIdSchema.parse(snapshotId)}/${EntityIdSchema.parse(mediaId)}?v=${revision}`;
}
async function readPage(snapshotId: string, cursor: string | undefined, signal: AbortSignal) {
  const response = await fetch(
    `/api/capture-media/${snapshotId}${cursor ? `?after=${cursor}` : ""}`,
    { cache: "no-store", signal },
  );
  const body = await response.json().catch(() => null);
  if (!response.ok)
    throw new CaptureMediaReadError(
      response.status,
      typeof body?.message === "string" ? body.message : "媒体状态读取未完成",
    );
  const page = CaptureMediaPageSchema.safeParse(body);
  if (!page.success || page.data.snapshotId !== snapshotId)
    throw new CaptureMediaReadError(502, "媒体状态内容不完整 请刷新重试");
  return page.data;
}
export function useCaptureMedia(snapshotId: string | undefined, visible = true) {
  const [state, setState] = useState<{
    snapshotId?: string;
    value?: CaptureMediaPage;
    error?: string;
    denied?: boolean;
    busy: boolean;
  }>({ busy: false });
  const pages = useRef<CaptureMediaPage[]>([]),
    request = useRef<AbortController | null>(null),
    busy = useRef(false),
    timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const load = useCallback(
    async (append = false) => {
      if (!visible || busy.current) return;
      if (!EntityIdSchema.safeParse(snapshotId).success) {
        setState({ snapshotId, busy: false, error: "未绑定可读取的采集快照" });
        return;
      }
      busy.current = true;
      const controller = new AbortController();
      request.current = controller;
      setState((previous) => ({
        ...(previous.snapshotId === snapshotId ? previous : {}),
        snapshotId,
        busy: true,
        error: undefined,
      }));
      try {
        let updated: CaptureMediaPage[];
        if (append) {
          const cursor = pages.current.at(-1)?.nextCursor;
          if (!cursor) return;
          updated = [...pages.current, await readPage(snapshotId!, cursor, controller.signal)];
        } else {
          updated = [];
          let cursor: string | undefined;
          for (let index = 0; index < Math.max(1, pages.current.length); index++) {
            const page = await readPage(snapshotId!, cursor, controller.signal);
            updated.push(page);
            if (!page.nextCursor || !page.canReadArchive) break;
            cursor = page.nextCursor;
          }
        }
        if (controller.signal.aborted) return;
        pages.current = updated;
        const first = updated[0]!;
        setState({
          snapshotId,
          busy: false,
          value: {
            ...first,
            media: updated.flatMap((page) => page.media),
            nextCursor: updated.at(-1)!.nextCursor,
            canReadArchive: updated.every((page) => page.canReadArchive),
            archivedItem: updated.some((page) => page.archivedItem),
          },
        });
      } catch (error) {
        if (controller.signal.aborted) return;
        const inaccessible =
          error instanceof CaptureMediaReadError && [401, 403, 404].includes(error.status);
        if (inaccessible) pages.current = [];
        setState((previous) => ({
          snapshotId,
          value: inaccessible ? undefined : previous.value,
          denied: inaccessible,
          busy: false,
          error: error instanceof Error ? error.message : "媒体状态读取未完成",
        }));
      } finally {
        if (request.current === controller) {
          busy.current = false;
          setState((previous) => ({ ...previous, busy: false }));
        }
      }
    },
    [snapshotId, visible],
  );
  useEffect(() => {
    pages.current = [];
    busy.current = false;
    if (visible) void load();
    return () => {
      request.current?.abort();
      clearTimeout(timer.current);
    };
  }, [load, visible]);
  useEffect(() => {
    if (!visible || state.denied || !EntityIdSchema.safeParse(snapshotId).success) return;
    let stopped = false;
    const schedule = () => {
      const value = pages.current[0];
      timer.current = setTimeout(
        tick,
        value && !value.counts.queued && !value.counts.processing ? 30_000 : 5000,
      );
    };
    const tick = async () => {
      if (stopped) return;
      if (document.visibilityState === "visible") await load();
      if (!stopped) schedule();
    };
    schedule();
    return () => {
      stopped = true;
      clearTimeout(timer.current);
    };
  }, [load, visible, state.denied]);
  return {
    ...(state.snapshotId === snapshotId ? state : { busy: visible }),
    refresh: load,
    loadMore: () => load(true),
  };
}
