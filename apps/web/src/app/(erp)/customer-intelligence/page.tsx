import {
  CustomerIntelligenceWorkspaceViewSchema,
  type CustomerIntelligenceWorkspaceView,
} from "@yummyai/contracts/customer-intelligence";
import { Megaphone } from "lucide-react";
import {
  AdvertisingWorkspaceSchema,
  type AdvertisingWorkspace,
} from "@yummyai/contracts/advertising";
import { AdvertisingWorkbench } from "../../../features/customer-intelligence/advertising-workbench";
import { apiFetch } from "../../../server-api";

export const dynamic = "force-dynamic";

export default async function CustomerIntelligencePage() {
  const [result, advertising] = await Promise.all([loadWorkspace(), loadAdvertising()]);
  return (
    <div className="research-shell customer-intelligence-shell">
      <main className="research-main customer-intelligence-main">
        <header className="customer-intelligence-header">
          <div>
            <p className="kicker">ADVERTISING / KEYWORDS / VOICE OF CUSTOMER</p>
            <h1>广告与 VOC</h1>
            <p>按产品切换推排名与保利润，把报表证据、调整记录和复盘连起来。</p>
          </div>
          <div className="customer-intelligence-integrity">
            <Megaphone size={18} />
            <span>
              <b>每日广告复盘</b>导入报表 · 审阅建议 · 记录执行 · 观察结果
            </span>
          </div>
        </header>
        <AdvertisingWorkbench
          initialData={advertising.data ?? null}
          initialError={advertising.error}
          vocData={"data" in result ? result.data : null}
          vocError={"error" in result ? result.error : undefined}
        />
      </main>
    </div>
  );
}
async function loadAdvertising(): Promise<{ data?: AdvertisingWorkspace; error?: string }> {
  const base = process.env.API_BASE_URL;
  if (!base) return { error: "尚未配置广告 API" };
  try {
    const response = await apiFetch(`${base.replace(/\/$/, "")}/v1/advertising/workspace`, {
      cache: "no-store",
    });
    if (!response.ok)
      return {
        error:
          response.status === 403
            ? "当前成员缺少广告读取权限"
            : response.status === 401
              ? "身份会话无效，请重新登录"
              : `广告工作区读取失败 (${response.status})`,
      };
    return { data: AdvertisingWorkspaceSchema.parse(await response.json()) };
  } catch {
    return { error: "广告工作区暂不可用，请重试" };
  }
}
async function loadWorkspace(): Promise<
  | { data: CustomerIntelligenceWorkspaceView }
  | { error: string; kind: "unauthorized" | "forbidden" | "failed" }
> {
  const apiBase = process.env.API_BASE_URL;
  if (!apiBase) return { error: "尚未配置广告与 VOC API。", kind: "failed" };
  try {
    const response = await apiFetch(
      `${apiBase.replace(/\/$/, "")}/v1/customer-intelligence/workspace`,
      { cache: "no-store" },
    );
    if (!response.ok) {
      if (response.status === 401)
        return { error: "身份会话无效，请重新登录本地身份服务。", kind: "unauthorized" };
      if (response.status === 403)
        return { error: "当前成员没有 customer_intelligence:read 权限。", kind: "forbidden" };
      return { error: `广告与 VOC 工作区读取失败 (${response.status})。`, kind: "failed" };
    }
    return { data: CustomerIntelligenceWorkspaceViewSchema.parse(await response.json()) };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : "广告与 VOC 工作区读取失败。",
      kind: "failed",
    };
  }
}
