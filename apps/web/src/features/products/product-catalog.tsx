import {
  ArrowRight,
  Boxes,
  CircleDollarSign,
  FileCheck2,
  ListFilter,
  Search,
  SlidersHorizontal,
} from "lucide-react";
import Link from "next/link";

import { ProductCreatePanel } from "./product-create-panel";
import type { ProductPlanView } from "./product-editor";

interface ProductCatalogProps {
  items: ProductPlanView[];
  owner: string;
  query: string;
  selectedId?: string;
  status: string;
}

export function ProductCatalog({ items, owner, query, selectedId, status }: ProductCatalogProps) {
  const filtered = filterProductPlans(items, query, status, owner);
  const owners = [...new Map(items.flatMap((item) =>
    item.ownerUserId ? [[item.ownerUserId, item.ownerName ?? item.ownerUserId] as const] : [],
  )).entries()];
  const pendingCount = items.filter((item) => item.status === "pending_approval").length;
  const activeCount = items.filter((item) =>
    ["approved", "developing", "listing"].includes(item.status),
  ).length;
  const readyCount = items.filter((item) => item.status === "ready").length;

  return (
    <section className="product-catalog" aria-labelledby="product-catalog-title">
      <header className="product-catalog-header">
        <div>
          <p className="section-code">PRODUCT DIRECTORY</p>
          <h2 id="product-catalog-title">产品目录</h2>
          <p>从企划证据扫描到可刊登状态，先定位产品，再进入版本化开发档案。</p>
        </div>
        <span>
          <Boxes aria-hidden="true" size={17} />
          {filtered.length} / {items.length} RECORDS
        </span>
      </header>

      <ProductCreatePanel defaultOpen={items.length === 0} />

      <dl className="product-catalog-signals" aria-label="产品目录摘要">
        <Signal
          icon={<Boxes aria-hidden="true" size={16} />}
          label="全部企划"
          value={items.length}
        />
        <Signal
          icon={<FileCheck2 aria-hidden="true" size={16} />}
          label="等待批准"
          value={pendingCount}
        />
        <Signal
          icon={<SlidersHorizontal aria-hidden="true" size={16} />}
          label="开发进行中"
          value={activeCount}
        />
        <Signal
          icon={<CircleDollarSign aria-hidden="true" size={16} />}
          label="可上架"
          value={readyCount}
        />
      </dl>

      <form action="/products" className="product-catalog-filters" method="get" aria-label="产品目录筛选">
        <label>
          <span>搜索</span>
          <span className="product-search-control">
            <Search aria-hidden="true" size={15} />
            <input
              autoComplete="off"
              defaultValue={query}
              name="q"
              placeholder="搜索产品名称或描述…"
              type="search"
            />
          </span>
        </label>
        <label>
          <span>产品状态</span>
          <select defaultValue={status} name="status">
            <option value="">全部状态</option>
            <option value="researching">研究中</option>
            <option value="pending_approval">待立项</option>
            <option value="approved">已立项</option>
            <option value="developing">开发中</option>
            <option value="listing">Listing 制作中</option>
            <option value="ready">可上架</option>
            <option value="archived">已归档</option>
          </select>
        </label>
        <label>
          <span>负责人</span>
          <select defaultValue={owner} name="owner">
            <option value="">全部负责人</option>
            {owners.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
          </select>
        </label>
        <button type="submit">
          <ListFilter aria-hidden="true" size={15} />
          应用筛选
        </button>
        {query || status || owner ? <Link href="/products">清除筛选</Link> : null}
      </form>

      {filtered.length ? (
        <div className="product-catalog-table-scroll">
          <table className="product-catalog-table">
            <thead>
              <tr>
                <th>产品企划</th>
                <th>SPU / SKU</th>
                <th>负责人</th>
                <th>状态</th>
                <th>目标成本</th>
                <th>审批证据</th>
                <th>定制字段</th>
                <th>更新时间</th>
                <th aria-label="操作" />
              </tr>
            </thead>
            <tbody>
              {filtered.map((item) => (
                <tr className={selectedId === item.id ? "is-selected" : undefined} key={item.id}>
                  <td>
                    <strong>{item.name}</strong>
                    <span>{item.description ?? "暂无产品描述"}</span>
                    <code>{item.id}</code>
                  </td>
                  <td>
                    <strong className="numeric">{item.spu?.code ?? "SPU 待创建"}</strong>
                    <span>{item.spu ? `${item.spu.skus.length} 个 SKU` : "尚无 SKU"}</span>
                  </td>
                  <td>
                    <strong>{item.ownerName ?? "未分配"}</strong>
                    <span>{item.ownerUserId ? item.ownerUserId.slice(0, 12) : "—"}</span>
                  </td>
                  <td>
                    <span className={`product-catalog-status status-${item.status}`}>
                      {statusLabel(item.status)}
                    </span>
                  </td>
                  <td className="numeric">{formatMoney(item.targetCost)}</td>
                  <td>
                    <strong className="numeric">{item.sourceReportIds.length}</strong>
                    <span>份来源报告</span>
                  </td>
                  <td>
                    <strong className="numeric">{item.customization.fields.length}</strong>
                    <span>SCHEMA V{item.customization.version}</span>
                  </td>
                  <td><time>{formatDate(item.updatedAt)}</time></td>
                  <td>
                    <Link
                      aria-label={`打开 ${item.name}`}
                      href={productHref(item.id, query, status, owner)}
                    >
                      <ArrowRight aria-hidden="true" size={16} />
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="product-catalog-empty">
          <Search aria-hidden="true" size={24} />
          <strong>没有匹配的产品企划</strong>
          <span>调整名称或状态筛选；系统不会用演示产品填充结果。</span>
        </div>
      )}
    </section>
  );
}

export function filterProductPlans(
  items: ProductPlanView[],
  query: string,
  status: string,
  owner = "",
): ProductPlanView[] {
  const normalizedQuery = query.trim().toLocaleLowerCase("zh-CN");
  return items.filter((item) => {
    if (status && item.status !== status) return false;
    if (owner && item.ownerUserId !== owner) return false;
    if (!normalizedQuery) return true;
    return [item.name, item.description ?? "", item.id].some((value) =>
      value.toLocaleLowerCase("zh-CN").includes(normalizedQuery),
    );
  });
}

function Signal({ icon, label, value }: { icon: React.ReactNode; label: string; value: number }) {
  return (
    <div>
      {icon}
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function productHref(id: string, query: string, status: string, owner: string): string {
  const params = new URLSearchParams({ plan: id });
  if (query) params.set("q", query);
  if (status) params.set("status", status);
  if (owner) params.set("owner", owner);
  return `/products?${params.toString()}#product-detail`;
}

function formatDate(value?: string): string {
  if (!value) return "未提供";
  return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(value));
}

function formatMoney(value?: { amount: number; currency: string }): string {
  if (!value) return "未核算";
  return new Intl.NumberFormat("zh-CN", { currency: value.currency, style: "currency" }).format(
    value.amount,
  );
}

function statusLabel(status: ProductPlanView["status"]): string {
  return {
    approved: "已立项",
    archived: "已归档",
    developing: "开发中",
    listing: "Listing 制作中",
    pending_approval: "待立项",
    ready: "可上架",
    researching: "研究中",
  }[status];
}
