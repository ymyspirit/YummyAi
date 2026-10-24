"use client";
import { useEffect, useState, type ReactNode } from "react";
import { Plus, Trash2 } from "lucide-react";
import { BenchmarkDatasetPageSchema, BenchmarkDatasetSchema, BenchmarkVersionPageSchema, BenchmarkVersionSchema,
  SaveBenchmarkDatasetSchema, PublishBenchmarkDatasetSchema, BUSINESS_BENCHMARK_ROLES, benchmarkCaseLabel, type BenchmarkDataset,
  type BenchmarkCase, type BenchmarkVersion, type KnowledgeBenchmarkCase, type BusinessBenchmarkCase } from "@yummyai/contracts/knowledge/benchmark";
import { KNOWLEDGE_TOPICS } from "@yummyai/contracts/knowledge";
import { TaskDrawer, TaskDrawerActions } from "../navigation/task-drawer";
import { useBenchmarkRead, useBenchmarkPage, useBenchmarkMutation, useBenchmarkDismiss, type BenchmarkScope, type BenchmarkMutation, type BusinessBenchmarkTask } from "./knowledge-benchmark-client";
import { BenchmarkRoleInput } from "./knowledge-benchmark-role-input";
import { BenchmarkBusinessTaskView, benchmarkRoleNames } from "./knowledge-benchmark-role-result";

export function BenchmarkPairs({ children }: { children: ReactNode }) { return <dl className="kb-benchmark-pairs">{children}</dl>; }
export function BenchmarkPair({ label, children }: { label: string; children: ReactNode }) { return <div><dt>{label}</dt><dd>{children}</dd></div>; }
export function BenchmarkMutationFeedback({ action, onDone, doneLabel = "确认原回执并继续" }: { action: BenchmarkMutation; onDone(id: string): void; doneLabel?: string }) {
  return <>{action.error && <p role="alert" className="kb-error">{action.error}</p>}
    {action.busy && <p role="status">正在核对原请求 请勿重复登记</p>}
    {action.frozen && !action.receipt && !action.busy && <section className="kb-benchmark-notice" aria-label="原请求结果待核对">
      <p>本页保留原填写和原编号 未确认结果时不换键 不自动更新依据</p><p>原请求编号 <code>{action.frozen.requestId}</code></p>
      <button className="oc-button" onClick={() => void action.retry()}>按固定正文和原编号重试</button>
      <p className="kb-meta">刷新后不保存问题 答案 人审或费用正文 可在原请求恢复区只读查回执 查不到不表示原写入未提交</p></section>}
    {action.receipt && <section className="kb-benchmark-notice" aria-label="实际登记回执"><h4>实际登记回执</h4>
      <p>原记录 <code>{action.receipt.id}</code> · 修订 {action.receipt.revision}</p><p className="kb-meta">此编号证明原操作已登记 后续读取失败不自动重做</p>
      <button className="oc-button" onClick={() => { const id = action.receipt!.id; if (action.clear()) onDone(id); }}>{doneLabel}</button></section>}</>;
}
export function BenchmarkPager({ page, label }: { page: ReturnType<typeof useBenchmarkPage>; label: string }) {
  return <div className="kb-benchmark-pager" aria-label={label + "分页"}>
    <p role="status">{page.reading ? "正在读取 " : ""}当前页 {page.data?.items.length ?? 0} 条 · 完整查询共 {page.data?.total ?? "待核对"} 条{page.data ? page.data.nextCursor ? " · 尚有下一页" : " · 本次查询已到末页" : " · 尚未读取完成"}</p>
    <button className="oc-button" disabled={page.reading} onClick={page.reset}>重新读取{label}</button>
    <button className="oc-button" disabled={page.reading || !page.canPrevious} onClick={page.previous}>上一页{label}</button>
    <button className="oc-button" disabled={page.reading || !page.data?.nextCursor} onClick={page.next}>下一页{label}</button>
    {page.error && <p className="kb-error" role="alert">{page.error} 本页未作为完整历史</p>}</div>;
}
const split = (text: string) => text.split("\n").map(value => value.trim()).filter(Boolean);
function Lines({ label, values, onChange, required = false }: { label: string; values: string[]; onChange(value: string[]): void; required?: boolean }) {
  const [text, setText] = useState(values.join("\n"));
  useEffect(() => { if (split(text).join("\n") !== values.join("\n")) setText(values.join("\n")); }, [values, text]);
  return <label>{label}<textarea aria-label={label} required={required} value={text} onChange={event => { setText(event.target.value); onChange(split(event.target.value)); }} /></label>;
}
const blankCase = (): KnowledgeBenchmarkCase => ({ key: "", role: "knowledge_answer", evaluation: { label: "", search: { query: "", topic: "all", platform: "all", market: "ALL", spuIds: [] },
  expectedFacts: [], forbiddenClaims: [], requiredEntryIds: [], expectRefusal: false }, calculations: [] });
type DraftKnowledge = KnowledgeBenchmarkCase & { editorKey: string };
type DraftBusiness = Omit<BusinessBenchmarkCase, "task"> & { task: BusinessBenchmarkTask | null; editorKey: string };
type DraftCase = DraftKnowledge | DraftBusiness;
type DraftFields = { name: string; description: string; items: DraftCase[] };
const draftCase = (item: BenchmarkCase): DraftCase => item.role === "knowledge_answer" ? { ...structuredClone(item), editorKey: crypto.randomUUID() }
  : { ...structuredClone(item), task: structuredClone(item.task), editorKey: crypto.randomUUID() };
const blankBusiness = (role: DraftBusiness["role"]): DraftBusiness => ({ key: "", role, label: "", task: null, expectedFacts: [], forbiddenClaims: [], expectRefusal: false, editorKey: crypto.randomUUID() });
const cleanFields = (fields: DraftFields) => ({ ...fields, items: fields.items.map(({ editorKey: _editorKey, ...item }) => { void _editorKey; return item; }) });

export function BenchmarkVersionView({ value }: { value: BenchmarkVersion }) {
  return <section aria-label="固定发布版本"><h3>{value.name} · 发布 V{value.version}</h3><BenchmarkPairs>
    <BenchmarkPair label="发布版本 ID"><code>{value.id}</code></BenchmarkPair><BenchmarkPair label="原数据集 / 草稿修订"><code>{value.datasetId}</code> · {value.datasetRevision}</BenchmarkPair>
    <BenchmarkPair label="固定样本与范围">{value.itemCount} 题 · {value.dataScope}</BenchmarkPair><BenchmarkPair label="版本校验值"><code>{value.checksum}</code></BenchmarkPair>
    <BenchmarkPair label="依据保留截止">{value.basisExpiresAt}</BenchmarkPair></BenchmarkPairs>
    <p>{value.description === undefined ? "原发布说明未保留 不采用今天草稿说明" : value.description || "原发布说明为空"}</p>
    <p className="kb-meta">知识问答与业务角色分别固定 原来源或方法失效会阻断新运行 不替换成今天资料 创意 制图和模板结论不等于生产放行</p>
    {value.items.map(item => <details className="kb-benchmark-details" key={item.id}><summary>{item.ordinal + 1} · {benchmarkCaseLabel(item.fields)} · {item.usable ? "本次读取可用" : "当前依据不可用于新尝试"}</summary>
      <BenchmarkPairs><BenchmarkPair label="原样本 / 原问题"><code>{item.id}</code><br />{item.caseId ? <code>{item.caseId}</code> : "业务样本 无知识问题记录"}</BenchmarkPair>
        <BenchmarkPair label="题目键与角色">{item.fields.key} · {benchmarkRoleNames[item.fields.role]}</BenchmarkPair><BenchmarkPair label="原问题校验值"><code>{item.caseChecksum}</code></BenchmarkPair>
        <BenchmarkPair label="原样本依据"><code>{item.basisFingerprint}</code></BenchmarkPair><BenchmarkPair label="原任务指纹"><code>{item.taskFingerprint}</code></BenchmarkPair>
        {item.fields.role === "knowledge_answer" && <BenchmarkPair label="原问题与范围">{item.fields.evaluation.search.query}<br />{item.fields.evaluation.search.topic} / {item.fields.evaluation.search.platform} / {item.fields.evaluation.search.market}</BenchmarkPair>}
        <BenchmarkPair label="原方法">{item.method ? item.method.methodKey + " · " + item.method.contractChecksum : "未保留方法 不补造"}</BenchmarkPair></BenchmarkPairs>
      {item.fields.role !== "knowledge_answer" && <BenchmarkBusinessTaskView task={item.fields.task} />}
      <p>期望事实 {(item.fields.role === "knowledge_answer" ? item.fields.evaluation.expectedFacts : item.fields.expectedFacts).join(" · ") || "未配置"}</p><p>禁止表述 {(item.fields.role === "knowledge_answer" ? item.fields.evaluation.forbiddenClaims : item.fields.forbiddenClaims).join(" · ") || "未配置"}</p>
      <p>{(item.fields.role === "knowledge_answer" ? item.fields.evaluation.expectRefusal : item.fields.expectRefusal) ? "本题要求缺证据时拒答" : "本题未要求一律拒答"}</p>
      <ul>{item.sourcePins.map(source => <li key={source.sourceId}>{source.title}{"kind" in source ? " · 原业务来源" : " · V" + source.version}<br /><code>{"kind" in source ? source.resourceId : source.entryId}</code><br /><code>{source.checksum}</code>
        {"kind" in source && source.resourceBindings && <details className="kb-benchmark-details"><summary>原固定资源与逐项权限范围 · {source.resourceBindings.items.length} 项</summary>
          <p className="kb-meta">原服务器固定的资源标识与权限范围 当前读取和运行仍由原业务拥有者重新授权 这些标识不授予资产访问权</p>
          <dl className="kb-benchmark-pairs">{Object.entries(source.resourceBindings.permissionScopes).map(([bit, scope]) => <div key={bit}><dt>{bit}</dt><dd>{scope}</dd></div>)}</dl>
          <ul>{source.resourceBindings.items.map(resource => <li key={resource.kind + ":" + resource.id}>{resource.kind}<br /><code>{resource.id}</code>
            {resource.parentId && <p>原父记录 <code>{resource.parentId}</code></p>}{resource.versionId && <p>原版本 <code>{resource.versionId}</code></p>}{resource.checksum && <p>原校验值 <code>{resource.checksum}</code></p>}</li>)}</ul></details>}</li>)}</ul>
      {!item.sourcePins.length && <p className="kb-warning">未固定来源 覆盖不足保持可见</p>}
      {item.fields.role === "knowledge_answer" ? item.fields.calculations.map(calculation => <p key={calculation.key}>独立数值预期 {calculation.key} · {calculation.operator} · 操作数 {calculation.operands.join(" / ")} · 精度 {calculation.scale} · <strong>{calculation.expectedValue} {calculation.unit} {calculation.currency}</strong></p>)
        : <p className="kb-warning">业务断言只核对声明的文本与来源 不证明金额语义 采购最优性 图片质量或制造合规 人工核验仍必需</p>}
      <p className="kb-meta">上述预期仅供运营配置与评分核对 不作为模型答案输入</p></details>)}
  </section>;
}

export function KnowledgeBenchmarkDataset({ scope, onUseVersion, initialDatasetId = "", initialVersionId = "" }: { scope: BenchmarkScope; onUseVersion(id: string): void; initialDatasetId?: string; initialVersionId?: string }) {
  const page = useBenchmarkPage("datasets", BenchmarkDatasetPageSchema, scope);
  const [selected, setSelected] = useState(initialDatasetId), [idDraft, setIdDraft] = useState(""), [versionId, setVersionId] = useState(initialVersionId);
  const [editor, setEditor] = useState<{ value: BenchmarkDataset | null } | null>(null), [retention, setRetention] = useState("7"), [reason, setReason] = useState("");
  const detail = useBenchmarkRead(selected ? "datasets/" + selected : null, BenchmarkDatasetSchema, scope, selected);
  const versions = useBenchmarkPage(selected ? "datasets/" + selected + "/versions" : null, BenchmarkVersionPageSchema, scope);
  const version = useBenchmarkRead(versionId ? "versions/" + versionId : null, BenchmarkVersionSchema, scope, versionId);
  const publish = useBenchmarkMutation(scope);
  const canPublish = scope.canManage && scope.canRun && scope.canApprove;
  return <section aria-label="固定评测数据集"><header className="kb-section-toolbar"><h3>固定评测数据集</h3>
    {scope.canManage && <button className="oc-button primary" disabled={publish.locked} onClick={() => setEditor({ value: null })}><Plus size={14} aria-hidden="true" />新建数据集草稿</button>}</header>
    <p className="kb-meta">草稿可保存 1—50 题 明确发布需至少 2 题 发布固定真实问题 来源与方法 不调用付费模型</p>
    <p className="kb-warning">固定题目与预期长期保留 仅填写已脱敏分析内容 不填写客户原文或身份信息 原任务提示词 分析重点与补充说明也会进入固定历史</p>
    <BenchmarkPager page={page} label="数据集" /><ul className="kb-benchmark-list">{page.data?.items.map(item => <li key={item.id}>
      <div><strong>{item.name}</strong><p>{item.itemCount} 题 · 草稿修订 {item.revision}</p><code>{item.id}</code></div>
      <button className="oc-button" disabled={publish.locked} onClick={() => { setSelected(item.id); setVersionId(""); }}>读取数据集 {item.id.slice(-8)}</button></li>)}</ul>
    <form className="kb-benchmark-inline" aria-label="按原数据集 ID 读取" onSubmit={event => { event.preventDefault(); setSelected(idDraft.trim()); setVersionId(""); }}>
      <label>原数据集 ID<input disabled={publish.locked} value={idDraft} onChange={event => setIdDraft(event.target.value)} /></label><button className="oc-button" disabled={!idDraft.trim() || publish.locked}>读取原数据集</button></form>
    {detail.error && <p role="alert" className="kb-error">{detail.error}</p>}{detail.reading && <p role="status">正在读取原数据集</p>}
    {detail.data && <section className="kb-benchmark-section" aria-label="数据集草稿详情"><h3>{detail.data.name}</h3><p>{detail.data.fields.description}</p>
      <p>草稿修订 {detail.data.revision} · {detail.data.itemCount} 题 · <code>{detail.data.id}</code></p>
      {scope.canManage && <button className="oc-button" disabled={publish.locked} onClick={() => setEditor({ value: detail.data })}>编辑数据集草稿</button>}
      <details className="kb-benchmark-details"><summary>核对当前草稿各题</summary>{detail.data.fields.items.map(item => <div key={item.key}><p>{item.key} · {benchmarkCaseLabel(item)} · {benchmarkRoleNames[item.role]}</p>
        {item.role === "knowledge_answer" ? <p>{item.evaluation.search.platform}/{item.evaluation.search.market}<br />{item.evaluation.search.query}</p> : <BenchmarkBusinessTaskView task={item.task} />}</div>)}</details>
      {canPublish ? <form className="kb-form" aria-label="发布固定数据集" onSubmit={event => { event.preventDefault(); if (!detail.data) return;
        const input = PublishBenchmarkDatasetSchema.safeParse({ expectedRevision: detail.data.revision, retentionDays: Number(retention), reason, requestId: crypto.randomUUID() });
        if (input.success) void publish.submit("datasets/" + detail.data.id + "/publish", input.data); else publish.invalid("请核对发布原因 保留天数与原草稿修订"); }}>
        <fieldset disabled={publish.locked}><label>依据保留天数<input type="number" min="1" max="30" step="1" required value={retention} onChange={event => setRetention(event.target.value)} /></label>
          <label>发布核对依据<textarea aria-label="发布核对依据" required maxLength={1000} value={reason} onChange={event => setReason(event.target.value)} /></label>
          <p className="kb-meta">核对当前全部题目与来源后发布当前修订 已有发布版本及原实验不改变</p>
          <p className="kb-warning">发布前核对题目 预期及原任务文字已脱敏 这些字段长期保留 不随依据保留天数自动删除 本页未执行自动隐私检测</p>
          <button className="oc-button primary" disabled={detail.data.itemCount < 2}>核对并发布此数据集修订</button>{detail.data.itemCount < 2 && <p className="kb-warning">至少配置两道真实样本后才能发布</p>}</fieldset>
        </form> : <p className="kb-meta">发布需当前读取 管理 运行与审批权限 不以草稿保存代替发布</p>}
      <BenchmarkMutationFeedback action={publish} onDone={id => { setVersionId(id); versions.reset(); }} doneLabel="读取实际发布版本" />
      <h4>不可变发布版本</h4><BenchmarkPager page={versions} label="发布版本" /><ul className="kb-benchmark-list">{versions.data?.items.map(item => <li key={item.id}>
        <p>V{item.version} · 原草稿 {item.datasetRevision} · {item.itemCount} 题<br /><code>{item.id}</code></p><button className="oc-button" onClick={() => setVersionId(item.id)}>核对发布版本 {item.id.slice(-8)}</button></li>)}</ul>
    </section>}
    <form className="kb-benchmark-inline" aria-label="按发布版本 ID 读取" onSubmit={event => { event.preventDefault(); version.reload(); }}>
      <label>原发布版本 ID<input value={versionId} onChange={event => setVersionId(event.target.value.trim())} /></label><button className="oc-button" disabled={!versionId}>重新读取发布版本</button></form>
    {version.error && <p role="alert" className="kb-error">{version.error}</p>}{version.data && <><BenchmarkVersionView value={version.data} />
      <button className="oc-button primary" onClick={() => onUseVersion(version.data!.id)}>按此固定版本准备实验</button></>}
    {editor && <DatasetEditor scope={scope} value={editor.value} onClose={() => setEditor(null)} onSaved={id => { setSelected(id); detail.reload(); page.reset(); setEditor(null); }} />}
  </section>;
}

function DatasetEditor({ scope, value, onClose, onSaved }: { scope: BenchmarkScope; value: BenchmarkDataset | null; onClose(): void; onSaved(id: string): void }) {
  const [fields, setFields] = useState<DraftFields>(() => value ? { ...value.fields, items: value.fields.items.map(draftCase) } : { name: "", description: "", items: [draftCase(blankCase())] });
  const [reason, setReason] = useState(""), action = useBenchmarkMutation(scope);
  const exit = useBenchmarkDismiss(scope, onClose);
  const change = (index: number, update: (item: KnowledgeBenchmarkCase) => KnowledgeBenchmarkCase) => setFields(previous => ({ ...previous, items: previous.items.map((item, at) => at === index && item.role === "knowledge_answer" ? { ...update(item), editorKey: item.editorKey } : item) }));
  const changeBusiness = (index: number, patch: Partial<DraftBusiness>) => setFields(previous => ({ ...previous, items: previous.items.map((item, at) => at === index && item.role !== "knowledge_answer" ? { ...item, ...patch } : item) }));
  const family = fields.items[0]?.role === "knowledge_answer" ? "knowledge" : "business";
  const unfinished = fields.items.some(item => item.role !== "knowledge_answer" && !item.task);
  const dirty = reason !== "" || JSON.stringify(cleanFields(fields)) !== JSON.stringify(value?.fields ?? { name: "", description: "", items: [blankCase()] });
  return <TaskDrawer title={value ? "编辑固定数据集草稿" : "新建固定数据集草稿"} state={{ dirty: dirty && !action.receipt && !exit.closing, busy: action.busy, loading: false }} onClose={() => exit.dismiss()}
    footer={<TaskDrawerActions><button className="oc-button" disabled={action.busy || exit.closing} onClick={() => { if (!dirty || action.receipt || window.confirm("关闭将清除本页问题填写 原请求回执仍可按编号核对")) exit.dismiss(); }}>关闭草稿填写</button>
      <button className="oc-button primary" type="submit" form="kb-benchmark-dataset-form" disabled={action.locked || exit.closing || unfinished}>保存数据集草稿</button></TaskDrawerActions>}>
    <div className="kb-benchmark" data-benchmark-closing={exit.closing} inert={exit.closing}>
    <form id="kb-benchmark-dataset-form" className="kb-form kb-benchmark" aria-label="编辑固定数据集" onSubmit={event => { event.preventDefault();
      const parsed = SaveBenchmarkDatasetSchema.safeParse({ fields: cleanFields(fields), expectedRevision: value?.revision ?? 0, reason, requestId: crypto.randomUUID() });
      if (parsed.success) void action.submit(value ? "datasets/" + value.id + "/save" : "datasets", parsed.data); else action.invalid("请核对所有样本的标识 问题 范围 引用 ID 与独立数值预期 未截断或补造"); }}>
      <fieldset disabled={action.locked}><label>数据集名称<input required maxLength={180} value={fields.name} onChange={event => setFields(previous => ({ ...previous, name: event.target.value }))} /></label>
        <label>数据集说明<textarea aria-label="数据集说明" maxLength={2000} value={fields.description} onChange={event => setFields(previous => ({ ...previous, description: event.target.value }))} /></label>
        <p className="kb-warning">固定题目与预期长期保留 仅填写已脱敏分析内容 不填写客户原文或身份信息 请先在原业务页面核对提示词 分析重点和补充说明</p>
        <label>固定样本类型<select aria-label="固定样本类型" value={family} onChange={event => {
          if (event.target.value === family || dirty && !window.confirm("切换知识或业务类型将清除本页全部原题目 仅改变未保存填写 是否继续")) return;
          setFields(previous => ({ ...previous, items: [event.target.value === "knowledge" ? draftCase(blankCase()) : blankBusiness(scope.businessRoles?.[0] ?? "procurement_review")] }));
        }}><option value="knowledge">知识问答样本</option><option value="business">业务角色样本</option></select></label>
        <p className="kb-meta">知识与业务不混在同一数据集 业务可混合八类真实角色 每题先固定原业务依据 选择“通用知识”不会扩大为跨平台全集</p>
        {unfinished && <p className="kb-warning">仍有业务样本尚未读取真实依据 固定全部原任务后才能保存草稿</p>}
        {fields.items.map((item, index) => <details open={index === 0 ? true : undefined} className="kb-benchmark-details" key={item.editorKey}><summary>样本 {index + 1} · {(item.role === "knowledge_answer" ? item.evaluation.label : item.label) || "尚未填写题名"}</summary>
          <div className="kb-benchmark-case" role="group" aria-label={"样本 " + (index + 1)}><label>样本稳定标识<input required pattern={"[a-z][a-z0-9_\\-]{0,59}"} value={item.key} onChange={event => setFields(previous => ({ ...previous, items: previous.items.map((old, at) => at === index ? { ...old, key: event.target.value } : old) }))} /></label>
            {item.role === "knowledge_answer" ? <>
            <label>题目名称<input required maxLength={180} value={item.evaluation.label} onChange={event => change(index, current => ({ ...current, evaluation: { ...current.evaluation, label: event.target.value } }))} /></label>
            <label>固定业务问题<textarea aria-label="固定业务问题" required maxLength={300} value={item.evaluation.search.query} onChange={event => change(index, current => ({ ...current, evaluation: { ...current.evaluation, search: { ...current.evaluation.search, query: event.target.value } } }))} /></label>
            <div className="kb-form-grid"><label>主题<select aria-label="主题" value={item.evaluation.search.topic} onChange={event => change(index, current => ({ ...current, evaluation: { ...current.evaluation, search: { ...current.evaluation.search, topic: event.target.value as typeof item.evaluation.search.topic } } }))}>
              <option value="all">全部主题</option>{Object.entries(KNOWLEDGE_TOPICS).map(([key, name]) => <option value={key} key={key}>{name}</option>)}</select></label>
              <label>平台<select aria-label="平台" value={item.evaluation.search.platform} onChange={event => change(index, current => ({ ...current, evaluation: { ...current.evaluation, search: { ...current.evaluation.search, platform: event.target.value as typeof item.evaluation.search.platform } } }))}>
                <option value="all">通用知识</option><option value="amazon">Amazon</option><option value="etsy">Etsy</option></select></label>
              <label>站点<input maxLength={3} required value={item.evaluation.search.market} onChange={event => change(index, current => ({ ...current, evaluation: { ...current.evaluation, search: { ...current.evaluation.search, market: event.target.value.toUpperCase() } } }))} /></label></div>
            <Lines label="固定 SPU ID 每行一个" values={item.evaluation.search.spuIds} onChange={values => change(index, current => ({ ...current, evaluation: { ...current.evaluation, search: { ...current.evaluation.search, spuIds: values } } }))} />
            <Lines label="期望事实 每行一项" values={item.evaluation.expectedFacts} onChange={values => change(index, current => ({ ...current, evaluation: { ...current.evaluation, expectedFacts: values } }))} />
            <Lines label="禁止表述 每行一项" values={item.evaluation.forbiddenClaims} onChange={values => change(index, current => ({ ...current, evaluation: { ...current.evaluation, forbiddenClaims: values } }))} />
            <Lines label="必需知识卡 ID 每行一个" values={item.evaluation.requiredEntryIds} onChange={values => change(index, current => ({ ...current, evaluation: { ...current.evaluation, requiredEntryIds: values } }))} />
            <label className="kb-checkbox"><input type="checkbox" checked={item.evaluation.expectRefusal} onChange={event => change(index, current => ({ ...current, evaluation: { ...current.evaluation, expectRefusal: event.target.checked } }))} />要求缺少依据时拒答</label>
            {item.calculations.map((calculation, at) => <div className="kb-benchmark-calculation" role="group" aria-label={"数值断言 " + (at + 1)} key={at}>
              <label>数值答案标识<input required pattern="[a-z][a-z0-9_]{0,59}" value={calculation.key} onChange={event => change(index, current => ({ ...current, calculations: current.calculations.map((old, ix) => ix === at ? { ...old, key: event.target.value } : old) }))} /></label>
              <label>白名单运算<select aria-label="白名单运算" value={calculation.operator} onChange={event => change(index, current => ({ ...current, calculations: current.calculations.map((old, ix) => ix === at ? { ...old, operator: event.target.value as typeof old.operator } : old) }))}>
                <option value="sum">求和</option><option value="difference">依次相减</option><option value="product">相乘</option><option value="quotient">两数相除</option></select></label>
              <Lines label="精确操作数 每行一个" required values={calculation.operands} onChange={values => change(index, current => ({ ...current, calculations: current.calculations.map((old, ix) => ix === at ? { ...old, operands: values } : old) }))} />
              <label>小数位数<input type="number" min="0" max="8" step="1" required value={calculation.scale} onChange={event => { if (event.target.value !== "") change(index, current => ({ ...current, calculations: current.calculations.map((old, ix) => ix === at ? { ...old, scale: Number(event.target.value) } : old) })); }} /></label>
              <label>单位<input required maxLength={40} value={calculation.unit} onChange={event => change(index, current => ({ ...current, calculations: current.calculations.map((old, ix) => ix === at ? { ...old, unit: event.target.value } : old) }))} /></label>
              <label>币种 无币种留空<input maxLength={3} value={calculation.currency ?? ""} onChange={event => change(index, current => ({ ...current, calculations: current.calculations.map((old, ix) => ix === at ? { ...old, currency: event.target.value ? event.target.value.toUpperCase() : null } : old) }))} /></label>
              <label>独立预期数值<input required inputMode="decimal" value={calculation.expectedValue} onChange={event => change(index, current => ({ ...current, calculations: current.calculations.map((old, ix) => ix === at ? { ...old, expectedValue: event.target.value } : old) }))} /></label>
              <button type="button" className="oc-button" onClick={() => change(index, current => ({ ...current, calculations: current.calculations.filter((_, ix) => ix !== at) }))}>移除此数值断言</button></div>)}
            <button type="button" className="oc-button" disabled={item.calculations.length >= 20} onClick={() => change(index, current => ({ ...current, calculations: [...current.calculations, { key: "", operator: "sum", operands: [], scale: 0, unit: "", currency: null, expectedValue: "" }] }))}>添加结构化数值断言</button>
            </> : <>
              <label>业务评测角色<select aria-label="业务评测角色" value={item.role} onChange={event => changeBusiness(index, { role: event.target.value as DraftBusiness["role"], task: null })}>
                {BUSINESS_BENCHMARK_ROLES.map(role => <option key={role} value={role}>{benchmarkRoleNames[role]}{scope.businessRoles?.includes(role) ? "" : " · 当前权限不足"}</option>)}</select></label>
              <label>题目名称<input required maxLength={180} value={item.label} onChange={event => changeBusiness(index, { label: event.target.value })} /></label>
              <BenchmarkRoleInput key={item.role} scope={scope} role={item.role} task={item.task} onChange={task => changeBusiness(index, { task })} />
              <Lines label="期望事实 每行一项" values={item.expectedFacts} onChange={expectedFacts => changeBusiness(index, { expectedFacts })} />
              <Lines label="禁止表述 每行一项" values={item.forbiddenClaims} onChange={forbiddenClaims => changeBusiness(index, { forbiddenClaims })} />
              <label className="kb-checkbox"><input type="checkbox" checked={item.expectRefusal} onChange={event => changeBusiness(index, { expectRefusal: event.target.checked })} />要求缺少依据时拒答</label>
              <p className="kb-warning">这些断言只检查声明的文本要求 不证明财务金额 采购最优性 图片质量或制造合规 不替代原业务规则与人工核验</p>
            </>}
            <button type="button" className="oc-button" disabled={fields.items.length < 2} onClick={() => setFields(previous => ({ ...previous, items: previous.items.filter((_, at) => at !== index) }))}><Trash2 size={14} aria-hidden="true" />移除本题</button>
          </div></details>)}
        <button type="button" className="oc-button" disabled={fields.items.length >= 50} onClick={() => setFields(previous => ({ ...previous, items: [...previous.items, family === "knowledge" ? draftCase(blankCase()) : blankBusiness(scope.businessRoles?.[0] ?? "procurement_review")] }))}><Plus size={14} aria-hidden="true" />添加固定样本</button>
        <label>草稿保存依据<textarea aria-label="草稿保存依据" required maxLength={1000} value={reason} onChange={event => setReason(event.target.value)} /></label>
      </fieldset>
    </form><BenchmarkMutationFeedback action={action} onDone={id => exit.dismiss(() => onSaved(id))} doneLabel="读取已保存数据集并关闭填写" /></div>
  </TaskDrawer>;
}
