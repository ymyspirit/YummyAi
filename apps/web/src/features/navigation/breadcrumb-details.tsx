"use client";

import { createContext, useContext, useEffect, useState, type Dispatch, type ReactNode, type SetStateAction } from "react";

type DetailLabel = { key: string; label: string } | null;
const DetailContext = createContext<DetailLabel>(null);
const SetDetailContext = createContext<Dispatch<SetStateAction<DetailLabel>> | null>(null);

export function BreadcrumbDetailsProvider({ children }: { children: ReactNode }) {
  const [detail, setDetail] = useState<DetailLabel>(null);
  return <SetDetailContext.Provider value={setDetail}>
    <DetailContext.Provider value={detail}>{children}</DetailContext.Provider>
  </SetDetailContext.Provider>;
}

/** Use the page's authorized, already-loaded record; navigation makes no data requests. */
export function useBreadcrumbDetail(key: string | null, label: string | undefined) {
  const setDetail = useContext(SetDetailContext);
  useEffect(() => {
    if (!setDetail || !key || !label) return;
    const detail = { key, label };
    setDetail(detail);
    return () => setDetail((current) => current === detail ? null : current);
  }, [key, label, setDetail]);
}

export function useBreadcrumbDetailLabel(key: string | undefined) {
  const detail = useContext(DetailContext);
  return detail?.key === key ? detail?.label : undefined;
}
