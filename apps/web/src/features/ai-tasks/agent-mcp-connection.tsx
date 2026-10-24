"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Check, ChevronDown, Copy, FileCode2, FileSearch, HelpCircle, LogIn, Plug, ShieldCheck, Terminal } from "lucide-react";
import { useOwnedViewTransition } from "../navigation/use-owned-view-transition";
import {
  AGENT_MCP_V2_START_COMMAND, AGENT_MCP_V2_READINESS_START_COMMAND, MCP_AUTH_PROFILE_PATH, MCP_PERSONAL_AUTH_COMMANDS, MCP_PROJECT_PATH,
  agentMcpHostTemplate, type McpConnectionVersion, type McpHostFormat,
} from "./agent-mcp-template";
import "./agent-mcp-connection.css";

export const AGENT_MCP_START_COMMAND = "pnpm --filter @yummyai/agent-mcp start";

const protocolEntries = [
  { name: "erp_capabilities_search", title: "搜索可用能力", description: "按业务目标查找能力目录 先核对当前本人可用范围" },
  { name: "erp_tool_schema", title: "读取所选工具定义", description: "按需读取输入 输出及执行边界 不把整份目录一次加载为任务依据" },
  { name: "erp_execute", title: "调用原工具", description: "按当前本人权限与本机策略调用 默认仅查询 付费模型任务和原准备另需显式允许" },
  { name: "erp_saved_result", title: "核对已保存结果", description: "用原标识读取实际保存的回执与结果 不因断线自动重新提交" },
  { name: "erp_usage", title: "读取任务费用", description: "读取单笔原任务已记录费用 未提供的费用与组织余额保持未知" },
] as const;

export function AgentMcpConnection() {
  const headingId = useId(), transition = useOwnedViewTransition();
  const alive = useRef(true), copySequence = useRef(0), copyLock = useRef(false), selectionSequence = useRef(0);
  const pendingChoice = useRef<{ version: McpConnectionVersion; format: McpHostFormat } | null>(null);
  const [choice, setChoice] = useState<{ version: McpConnectionVersion; format: McpHostFormat }>({ version: "v1", format: "codex" });
  const [changing, setChanging] = useState(false), [copyBusy, setCopyBusy] = useState(false);
  const [copyState, setCopyState] = useState<{ phase: "idle" | "copying" | "copied" | "failed"; target: string }>({ phase: "idle", target: "" });
  const version = choice.version, personal = version === "v2";
  const command = personal ? AGENT_MCP_V2_START_COMMAND : AGENT_MCP_START_COMMAND;
  const template = agentMcpHostTemplate(version, choice.format);

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; copySequence.current++; selectionSequence.current++; pendingChoice.current = null; };
  }, []);

  function clearCopy() { copySequence.current++; setCopyState({ phase: "idle", target: "" }); }
  function select(next: { version: McpConnectionVersion; format: McpHostFormat }) {
    const current = pendingChoice.current ?? choice;
    if (current.version === next.version && current.format === next.format) return;
    const sequence = ++selectionSequence.current; pendingChoice.current = next;
    clearCopy(); transition.cancel(); setChanging(true);
    transition.change(() => {
      if (!alive.current || sequence !== selectionSequence.current) return;
      pendingChoice.current = null; setChoice(next); setChanging(false);
    });
  }
  function close() {
    selectionSequence.current++; pendingChoice.current = null; transition.cancel(); setChanging(false); clearCopy();
  }
  async function copy(target: string, text: string) {
    if (!alive.current || copyLock.current || pendingChoice.current) return;
    copyLock.current = true;
    const sequence = ++copySequence.current;
    setCopyBusy(true); setCopyState({ phase: "copying", target });
    try {
      if (!navigator.clipboard?.writeText) throw new Error("clipboard_unavailable");
      await navigator.clipboard.writeText(text);
      if (alive.current && sequence === copySequence.current) setCopyState({ phase: "copied", target });
    } catch {
      if (alive.current && sequence === copySequence.current) setCopyState({ phase: "failed", target });
    } finally { copyLock.current = false; if (alive.current) setCopyBusy(false); }
  }
  const copied = (target: string) => copyState.phase === "copied" && copyState.target === target;
  const copyResult = copyState.phase === "copying" ? "正在复制无密钥命令或模板" : copyState.phase === "failed"
    ? "暂不能访问剪贴板 请手动复制对应命令或模板" : copyState.phase !== "copied" ? "" : copyState.target === "start"
      ? "已复制启动命令 连接仍需实际验证" : copyState.target === "readiness" ? "已复制只读诊断启动命令 当前客户端连接与任务执行服务仍未验证" : copyState.target === "template" ? "已复制无密钥宿主模板 尚未写入或验证宿主配置"
        : copyState.target === "login" ? "已复制登录命令 请在本机终端执行 此页未核对本机登录状态"
          : copyState.target === "status" ? "已复制登录状态命令 请在本机核对 此页尚未验证"
            : "已复制退出命令 请在本机执行 此页不声明已退出";

  return <section className="agent-mcp-connection" aria-labelledby={headingId}>
    <details onToggle={event => { if (!event.currentTarget.open) close(); }}>
      <summary>
        <span className="mcp-heading" id={headingId} role="heading" aria-level={2}><Plug size={17} aria-hidden="true" />MCP 本机接入</span>
        <span className="mcp-state"><HelpCircle size={14} aria-hidden="true" />当前客户端连接状态未知</span>
        <ChevronDown className="mcp-chevron" size={16} aria-hidden="true" />
      </summary>
      <div className="mcp-content">
        <p className="mcp-notice">本机 stdio 接入 需在实际客户端完成工具发现和调用验证 此页说明不代表 Codex 或其他宿主已经连接</p>
        <fieldset className="mcp-version-choice"><legend>ERP MCP 接入版本</legend>
          <label><input type="radio" name={headingId + "-version"} checked={version === "v1"} onChange={() => select({ ...(pendingChoice.current ?? choice), version: "v1" })} /><span><strong>原 v1 · 历史 native-v1</strong><small>保留原启动方式和原任务引用</small></span></label>
          <label><input type="radio" name={headingId + "-version"} checked={version === "v2"} onChange={() => select({ ...(pendingChoice.current ?? choice), version: "v2" })} /><span><strong>新 v2 · native-v3</strong><small>推荐用于新的本机接入 需个人登录</small></span></label>
        </fieldset>
        <div className="mcp-choice-content" data-version={version} aria-busy={changing}>
          <p className="mcp-version-note">{personal ? "当前方案是 ERP MCP v2 显式连接 native-v3 不转换旧任务或原准备" : "当前方案是原 ERP MCP v1 对应历史 native-v1 不随网页默认任务版本自动升级"}</p>
          <section aria-label="MCP 本机启动命令">
            <header className="mcp-command-heading"><h3><Terminal size={15} aria-hidden="true" />本机启动命令</h3><button type="button" disabled={copyBusy || changing} onClick={() => void copy("start", command)}>{copied("start") ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}复制启动命令</button></header>
            <code className="mcp-command">{command}</code>
            <p className="mcp-muted">{personal ? "示例显式包含 --allow-native-v3 付费新任务和原提案准备仍关闭 启动前先完成下方本机个人登录" : "旧启动方式使用受保护进程环境注入短时访问凭据 网页不显示或复制其值"}</p>
          </section>
          {personal ? <section className="mcp-auth" aria-label="MCP 本机个人登录"><h3><LogIn size={15} aria-hidden="true" />先在本机终端登录</h3>
            <p>将进程环境变量 <code>YUMMYAI_MCP_AUTH_PROFILE</code> 指向管理员提供的绝对配置路径 <code>{MCP_AUTH_PROFILE_PATH}</code></p>
            <p className="mcp-muted">管理员需预注册 public OIDC client 和 ERP audience 回调地址精确为 <code>http://127.0.0.1:12766/callback</code> 网页会话不能替代本机登录</p>
            <p className="mcp-muted">v2 个人模式不同时接受旧凭据环境 <code>YUMMYAI_MCP_ERP_ACCESS_TOKEN</code> 切换前应从可信启动环境移除该项</p>
            <dl className="mcp-auth-commands">{MCP_PERSONAL_AUTH_COMMANDS.map(item => <div key={item.id}><dt>{item.title}</dt><dd><code className="mcp-command">{item.command}</code><button type="button" disabled={copyBusy || changing} onClick={() => void copy(item.id, item.command)}>{copied(item.id) ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}{item.copyLabel}</button></dd></div>)}</dl>
            <p className="mcp-muted">本页不会执行这些命令或读取本机凭据 本机退出不代表已签发访问令牌即时失效 后续请求仍受有效期与当前权限约束</p>
          </section> : <p className="mcp-muted">v1 需要可信 ERP API 地址环境 <code>YUMMYAI_MCP_ERP_API_URL</code> 及短时凭据环境 <code>YUMMYAI_MCP_ERP_ACCESS_TOKEN</code> 模板不包含凭据值</p>}
          {personal && <section className="mcp-readiness" aria-label="MCP 只读启动诊断">
            <header className="mcp-command-heading"><h3><FileSearch size={15} aria-hidden="true" />只读启动诊断</h3><button type="button" disabled={copyBusy || changing} onClick={() => void copy("readiness", AGENT_MCP_V2_READINESS_START_COMMAND)}>{copied("readiness") ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}复制只读诊断启动命令</button></header>
            <p>逐项允许查询 loop plan native_v1 native_v2 native_v3 五类 ERP 已知启动阻断 仅核对当前模型配置 原权限和预算等有限条件 不调用模型或启动任务</p>
            <code className="mcp-command" aria-label="MCP v2 只读诊断启动命令">{AGENT_MCP_V2_READINESS_START_COMMAND}</code>
            <p className="mcp-muted">在实际宿主搜索对应 readiness/ 能力 再读取所选定义并查询 初步检查无已知阻断不代表本机已允许付费或任务执行服务在线</p>
            <p className="mcp-muted">本次请求金额 所选来源 模型提供方连通性与任务执行服务在线状态仍未验证 loop plan native_v2 的 MCP 启动入口尚未登记</p>
            <p className="mcp-muted">此命令只增加显式诊断允许范围 不增加模型付费或原准备开关 不修改宿主 IdP 或权限 当前客户端连接状态仍未知</p>
          </section>}
          <section className="mcp-host" aria-label="MCP 无密钥宿主模板">
            <header className="mcp-command-heading"><h3><FileCode2 size={15} aria-hidden="true" />无密钥宿主模板</h3><button type="button" disabled={copyBusy || changing} onClick={() => void copy("template", template)}>{copied("template") ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}复制宿主模板</button></header>
            <label className="mcp-host-format">宿主配置格式<select aria-label="宿主配置格式" value={choice.format} onChange={event => {
              const format = event.target.value; if (format === "codex" || format === "json") select({ ...(pendingChoice.current ?? choice), format });
            }}><option value="codex">Codex TOML</option><option value="json">通用 JSON</option></select></label>
            <pre className="mcp-template" tabIndex={0} aria-label="所选无密钥宿主配置模板"><code>{template}</code></pre>
            {!personal && choice.format === "json" && <p className="mcp-muted">通用 JSON 模板仅含公开启动参数 还须按宿主文档单独绑定受保护的短时凭据环境 复制模板不代表已经可以调用</p>}
            <p className="mcp-muted">替换 <code>{MCP_PROJECT_PATH}</code>{personal && <> 和 <code>{MCP_AUTH_PROFILE_PATH}</code></>} 为本机绝对路径 按宿主文档合并配置 不覆盖已有全局配置</p>
            <p className="mcp-muted">实际 stdio 宿主直接启动 Node 工作目录为 ERP 项目下的 <code>apps/agent-mcp</code> 包管理器命令仅供项目根目录的人工终端使用 本页只复制模板 不读取或修改宿主文件</p>
          </section>
        </div>
        <p className="mcp-copy-result" data-state={copyState.phase} role="status" aria-live="polite">{copyResult}</p>
        <dl className="mcp-boundaries">
          <div><dt>连接方式</dt><dd>由本机 MCP 客户端启动 stdio 进程 通过标准输入输出交换协议消息</dd></div>
          <div><dt><ShieldCheck size={14} aria-hidden="true" />本人凭据</dt><dd>{personal ? "由本机个人 OIDC 流程管理 本页不收取 显示或存储凭据" : "使用 ERP 本人的短时访问凭据 通过启动进程的环境注入 本页不收取 显示或存储凭据"}</dd></div>
          <div><dt>默认执行范围</dt><dd>默认仅查询 模型付费任务与原准备都需要本机显式策略开关及当前原业务权限 具体执行继续保留原确认</dd></div>
        </dl>
        <section aria-label="MCP 原业务资源允许范围"><h3>原业务资源读取</h3><p className="mcp-muted">研究 商品 Listing 订单 利润核算和广告分析需逐项在可信启动策略中允许 示例保留原五读取 不默认打开六类资源或本单履约</p><code className="mcp-command">--allow-resource=catalog.sku</code><p className="mcp-muted">每项资源分别添加允许参数 本单履约另需 <code>--allow-fulfillment</code> 当前权限仍由原业务拥有者核对</p></section>
        <dl className="mcp-adoption"><div><dt>当前页面方案</dt><dd>{personal ? "v2 · native-v3" : "v1 · native-v1"} · 仅配置示例</dd></div><div><dt>实际宿主配置</dt><dd>未读取 尚未核验</dd></div><div><dt>日常采用状态</dt><dd>尚未核验 不根据复制或网页登录推断</dd></div></dl>
        <section aria-label="MCP 五个协议入口"><h3><FileSearch size={15} aria-hidden="true" />五个协议入口</h3><dl className="mcp-methods">{protocolEntries.map(entry => <div key={entry.name}><dt><code>{entry.name}</code><strong>{entry.title}</strong></dt><dd>{entry.description}</dd></div>)}</dl></section>
        <p className="mcp-muted">验证时请在实际宿主发现上述入口 再完成一次本人受权的查询 原有网页任务与确认入口继续使用各自协议 此页不会启动连接或代替业务确认</p>
      </div>
    </details>
  </section>;
}
