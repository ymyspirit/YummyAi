import { ErpSidebar } from "../../../features/navigation/erp-sidebar";

export default function ResearchLoading() {
  return (
    <div className="research-shell" aria-busy="true">
      <ErpSidebar
        active="research"
        contextLabel="EVIDENCE ERP"
        note="公开页面证据、版本快照与媒体状态均保留来源链路。"
      />
      <main className="research-main">
        <header className="page-header">
          <div>
            <p className="kicker">RESEARCH / EVIDENCE INDEX</p>
            <h1>研究资料库</h1>
            <p>正在读取统一产品类型、筛选项和最新证据索引。</p>
          </div>
        </header>
        <section className="library-frame">
          <p className="empty-library" role="status">
            正在加载研究资料…
          </p>
        </section>
      </main>
    </div>
  );
}
