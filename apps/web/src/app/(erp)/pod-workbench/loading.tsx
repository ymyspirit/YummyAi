export default function PodWorkbenchLoading() {
  return (
    <div className="research-shell pod-shell" aria-busy="true" aria-label="正在加载作图中心">
      <aside className="side-rail pod-loading-rail" />
      <main className="research-main pod-main">
        <div className="pod-loading-block pod-loading-title" />
        <div className="pod-loading-block pod-loading-boundary" />
        <div className="pod-loading-grid">
          <div className="pod-loading-block" />
          <div className="pod-loading-block" />
        </div>
      </main>
    </div>
  );
}
