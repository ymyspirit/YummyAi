"use client";
import { Download, ChevronLeft, ChevronRight } from "lucide-react";
import type {
  SalesPlanDelivery,
  SalesPlanPackageView,
} from "@yummyai/contracts/catalog/sales-plan-delivery";

export function SalesPackageHistory({
  data,
  loading,
  pending,
  error,
  onPage,
  onDownload,
}: {
  data: SalesPlanDelivery;
  loading: boolean;
  pending: string | null;
  error: string;
  onPage: (page: number) => void;
  onDownload: (pack: SalesPlanPackageView) => void;
}) {
  return (
    <section className="sd-section sd-history" aria-label="历史封存资料包">
      {error && (
        <p role="alert" className="oc-notice oc-notice-error">
          {error}
        </p>
      )}
      <div className="sl-heading">
        <div>
          <h4>历史封存资料包</h4>
          <p className="sp-hint">
            保留原方案的所有封存记录 移除当前 SKU 不会删除历史 下载时核对原文件与当前读取权
          </p>
        </div>
      </div>
      {data.packages.length ? (
        <table className="sd-history-table">
          <caption className="sr-only">原方案资料包历史</caption>
          <thead>
            <tr>
              <th>原 SKU 与校验值</th>
              <th>版本</th>
              <th>依据</th>
              <th>文件</th>
            </tr>
          </thead>
          <tbody>
            {data.packages.map((pack) => (
              <tr key={pack.id}>
                <td>
                  <strong>{pack.skuCode}</strong>
                  <small title={pack.checksum}>{pack.checksum}</small>
                  <small>{pack.createdAt.replace("T", " ").slice(0, 19)} UTC</small>
                </td>
                <td>V{pack.version}</td>
                <td>
                  {pack.current && pack.reviewedDelivery ? "当前可交付" : "历史封存"}
                  <small>{pack.reviewedDelivery ? "含原交付核对" : "旧封存流程"}</small>
                </td>
                <td>
                  <a
                    className="oc-button"
                    aria-disabled={loading || pending !== null || !data.access.download}
                    href={pack.downloadPath}
                    onClick={(event) => {
                      event.preventDefault();
                      if (!loading && pending === null && data.access.download) onDownload(pack);
                    }}
                  >
                    <Download size={14} />
                    {pending === pack.id ? "正在核对" : "下载原包"}
                  </a>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="oc-empty">
          {data.packageHistory.page === 1 ? "本方案还没有封存资料包" : "本页没有可读取的封存记录"}
        </p>
      )}
      <nav className="sd-history-pages" aria-label="资料包历史分页">
        <button
          type="button"
          className="oc-button"
          disabled={loading || pending !== null || data.packageHistory.page === 1}
          onClick={() => onPage(data.packageHistory.page - 1)}
        >
          <ChevronLeft size={14} />
          上一页
        </button>
        <span>第 {data.packageHistory.page} 页</span>
        <button
          type="button"
          className="oc-button"
          disabled={loading || pending !== null || !data.packageHistory.hasMore}
          onClick={() => onPage(data.packageHistory.page + 1)}
        >
          下一页
          <ChevronRight size={14} />
        </button>
      </nav>
      <p className="sp-hint">
        历史包固定原审核与版本 不代表当前可发布或生产放行 原文件缺失或授权失效时会停止下载
      </p>
    </section>
  );
}
