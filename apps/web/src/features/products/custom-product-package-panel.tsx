"use client";

import type {
  AmazonCustomListingMaterialsReadiness,
  CustomProductAssetRole,
  CustomProductProfileV1,
} from "@yummyai/contracts";
import {
  AlertTriangle,
  BookOpenCheck,
  CheckCircle2,
  Download,
  FileArchive,
  FileSearch2,
  PackageOpen,
  RefreshCw,
  Save,
  ShieldCheck,
} from "lucide-react";
import Link from "next/link";
import { useActionState, useCallback, useEffect, useState } from "react";

import {
  generateProvisionalCustomProductProfile,
  saveCustomProductProfile,
  type CustomProductPackageActionState,
} from "./custom-product-package-actions";

const initialState: CustomProductPackageActionState = { message: "", status: "idle" };
const assetRoleLabels: Record<CustomProductAssetRole, string> = {
  real_product: "real_product",
  finished_sample: "finished_sample",
  packaging: "packaging",
  print_template: "print_template",
  style_reference: "style_reference",
  competitor_reference: "competitor_reference",
};

export function CustomProductPackagePanel({
  planId,
  profile,
  researchItemIds,
  customizationFieldKeys,
  editable,
}: {
  planId: string;
  profile?: CustomProductProfileV1;
  researchItemIds: string[];
  customizationFieldKeys: string[];
  editable: boolean;
}) {
  const [generateState, generateAction, generating] = useActionState(
    generateProvisionalCustomProductProfile.bind(null, planId),
    initialState,
  );
  const [saveState, saveAction, saving] = useActionState(
    saveCustomProductProfile.bind(null, planId),
    initialState,
  );

  if (!profile) {
    return (
      <section className="custom-package-frame" aria-labelledby="custom-package-title">
        <PanelHeader planId={planId} />
        <div className="custom-package-empty">
          <FileSearch2 aria-hidden="true" size={22} />
          <div>
            <strong>从研究资料建立临时产品事实</strong>
            <p>
              系统会复制竞品研究中的可用参数，但保留为未确认来源。竞品图片只进入分析清单，不会进入生图素材。
            </p>
          </div>
        </div>
        <form action={generateAction} className="custom-package-seed-form">
          <label>
            <span>研究资料 UUID</span>
            <input
              defaultValue={researchItemIds[0] ?? ""}
              disabled={!editable || generating}
              name="researchItemId"
              placeholder="019f..."
              required
            />
          </label>
          <label>
            <span>目标站点</span>
            <input
              defaultValue="amazon.com"
              disabled={!editable || generating}
              name="targetMarketplace"
              required
            />
          </label>
          <button disabled={!editable || generating} type="submit">
            {generating ? "生成中…" : "生成临时事实"}
          </button>
        </form>
        <ActionNotice state={generateState} />
        <ListingMaterialsGate planId={planId} />
      </section>
    );
  }

  const facts = collectFacts(profile);
  const confirmedCount = facts.filter((fact) => fact.verificationStatus === "confirmed").length;
  const competitorCount = facts.filter((fact) => fact.source === "competitor_reference").length;
  const unverifiedCount = facts.length - confirmedCount;
  const missing = releaseMissing(profile);
  const releaseCandidate =
    !missing.length && !unverifiedCount && profile.assetAssignments.length > 0;
  const surface = profile.surfaces[0];

  return (
    <section className="custom-package-frame" aria-labelledby="custom-package-title">
      <PanelHeader planId={planId} />
      <div className="custom-package-status-grid">
        <StatusMetric label="已确认事实" value={confirmedCount} tone="ready" />
        <StatusMetric label="待确认事实" value={unverifiedCount} tone="warning" />
        <StatusMetric label="竞品来源" value={competitorCount} tone="neutral" />
        <StatusMetric label="素材关联" value={profile.assetAssignments.length} tone="neutral" />
      </div>

      <div className="custom-package-advisory" role="note">
        <AlertTriangle aria-hidden="true" size={17} />
        <p>
          这是可编辑草稿。竞品参数不会自动成为自有宣称；勾选卖家确认后，当前表单中的事实才会转为
          seller_provided。正式导出仍会在服务端检查必填项和素材权利。
        </p>
      </div>

      {profile.researchItemIds[0] ? (
        <form action={generateAction} className="custom-package-regenerate">
          <input name="researchItemId" type="hidden" value={profile.researchItemIds[0]} />
          <input
            name="targetMarketplace"
            type="hidden"
            value={profile.targetMarketplace?.value ?? "amazon.com"}
          />
          <span>
            研究来源 <code>{profile.researchItemIds[0]}</code>
            <small>重新生成会覆盖当前产品事实草稿。</small>
          </span>
          <button disabled={!editable || generating} type="submit">
            {generating ? "重建中…" : "按研究源重建"}
          </button>
        </form>
      ) : null}
      <ActionNotice state={generateState} />

      <form action={saveAction} className="custom-package-form" key={profile.updatedAt}>
        <input name="currentProfile" type="hidden" value={JSON.stringify(profile)} />
        <input
          name="surfaceFieldKeys"
          type="hidden"
          value={JSON.stringify(
            surface?.fieldKeys.length ? surface.fieldKeys : customizationFieldKeys,
          )}
        />

        <fieldset disabled={!editable || saving}>
          <legend>产品事实</legend>
          <div className="custom-package-fields">
            <TextField label="SKU" name="sku" value={profile.sku?.value} />
            <TextField
              label="Amazon 站点"
              name="targetMarketplace"
              value={profile.targetMarketplace?.value}
            />
            <TextField label="产品类型" name="productType" value={profile.productType?.value} />
            <TextField label="品牌" name="brand" value={profile.brand?.value} />
            <TextArea
              label="材质，每行一项"
              name="materials"
              value={profile.materials.map((fact) => fact.value).join("\n")}
            />
            <TextArea
              label="颜色，每行一项"
              name="colors"
              value={profile.colors.map((fact) => fact.value).join("\n")}
            />
            <TextArea
              label="成品尺寸，每行一项"
              name="sizeOptions"
              value={profile.sizeOptions.map((fact) => fact.value).join("\n")}
            />
            <TextField
              inputMode="numeric"
              label="每包数量"
              name="packageQuantity"
              type="number"
              value={profile.packageQuantity?.value}
            />
            <TextArea
              label="包装包含内容，每行一项"
              name="packageContents"
              value={profile.packageContents.map((fact) => fact.value).join("\n")}
            />
            <TextArea
              label="生产与印刷工艺"
              name="manufacturingProcess"
              value={profile.manufacturingProcess?.value}
            />
            <TextArea
              label="目标人群，每行一项"
              name="targetAudiences"
              value={profile.targetAudiences.map((fact) => fact.value).join("\n")}
            />
            <TextArea
              label="真实卖点，每行一项"
              name="sellingPoints"
              value={profile.sellingPoints.map((fact) => fact.value).join("\n")}
            />
          </div>
        </fieldset>

        <fieldset disabled={!editable || saving}>
          <legend>定制面与素材</legend>
          <div className="custom-package-fields">
            <TextField label="定制面名称" name="surfaceLabel" value={surface?.label} />
            <TextField
              label="加工区域宽度 mm"
              name="areaWidthMm"
              type="number"
              value={surface?.areaMm?.width}
            />
            <TextField
              label="加工区域高度 mm"
              name="areaHeightMm"
              type="number"
              value={surface?.areaMm?.height}
            />
            <TextField label="定制面工艺" name="surfaceProcess" value={surface?.process} />
            <label className="custom-package-field custom-package-field-wide">
              <span>授权素材关联，每行“素材 UUID,角色”</span>
              <textarea
                defaultValue={profile.assetAssignments
                  .map((assignment) => `${assignment.assetId},${assetRoleLabels[assignment.role]}`)
                  .join("\n")}
                name="assetAssignments"
                placeholder={"019f...,real_product\n019f...,print_template"}
                rows={4}
              />
              <small>
                可用角色：real_product、finished_sample、packaging、print_template、style_reference。仅
                authorized 域且权利状态 approved 的素材会写入 ZIP。
              </small>
            </label>
          </div>
        </fieldset>

        <label className="custom-package-confirm">
          <input name="confirmFacts" type="checkbox" />
          <span>我已按自有实物、生产规格和包装清单核对当前表单，将全部现有事实标记为卖家确认</span>
        </label>

        <div className="custom-package-savebar">
          <span className="mono">
            PROFILE V1.0 · {facts.length} FACTS · {profile.researchItemIds.length} SOURCES
          </span>
          <button disabled={!editable || saving} type="submit">
            <Save aria-hidden="true" size={15} />
            {saving ? "保存中…" : editable ? "保存产品事实" : "产品计划已锁定"}
          </button>
        </div>
      </form>

      <ActionNotice state={saveState} />

      <div className="custom-package-export">
        <div>
          <FileArchive aria-hidden="true" size={20} />
          <span>
            <strong>Amazon Studio 产品包</strong>
            <small>草稿包可立即导出；正式包由服务端重新执行事实、素材与完整度校验。</small>
          </span>
        </div>
        <div className="custom-package-export-actions">
          <a href={`/v1/products/${planId}/custom-package?mode=draft`}>
            <Download aria-hidden="true" size={15} />
            下载草稿 ZIP
          </a>
          <a
            aria-disabled={!releaseCandidate}
            href={
              releaseCandidate ? `/v1/products/${planId}/custom-package?mode=release` : undefined
            }
          >
            <ShieldCheck aria-hidden="true" size={15} />
            下载正式 ZIP
          </a>
        </div>
      </div>

      {!releaseCandidate ? (
        <div className="custom-package-blockers">
          <strong>正式包暂未开放</strong>
          <ul>
            {unverifiedCount ? <li>{unverifiedCount} 项事实尚未由卖家确认</li> : null}
            {missing.map((item) => (
              <li key={item}>{item}</li>
            ))}
            {!profile.assetAssignments.length ? <li>至少关联一项自有或授权产品素材</li> : null}
          </ul>
        </div>
      ) : (
        <p className="custom-package-release-ready">
          <CheckCircle2 aria-hidden="true" size={16} />
          表单已达到正式包预检条件，下载时仍会核对素材域和权利状态。
        </p>
      )}
      <ListingMaterialsGate planId={planId} />
    </section>
  );
}

function ListingMaterialsGate({ planId }: { planId: string }) {
  const [readiness, setReadiness] = useState<AmazonCustomListingMaterialsReadiness>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);
  const load = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      const response = await fetch(`/v1/products/${planId}/listing-materials/readiness`, {
        cache: "no-store",
      });
      const payload = (await response.json().catch(() => undefined)) as
        AmazonCustomListingMaterialsReadiness | { message?: string } | undefined;
      if (!response.ok || !payload || !("groups" in payload)) {
        throw new Error(
          payload && "message" in payload
            ? payload.message
            : `资料齐套检查失败 (${response.status})`,
        );
      }
      setReadiness(payload);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "资料齐套检查失败。");
    } finally {
      setLoading(false);
    }
  }, [planId]);
  useEffect(() => {
    void load();
  }, [load]);

  const ready = readiness?.status === "ready";
  return (
    <section className="listing-materials-gate" aria-labelledby="listing-materials-title">
      <header>
        <div>
          <p className="section-code">SELLER CENTRAL / COMPLETE HANDOFF</p>
          <h3 id="listing-materials-title">Amazon Custom 上架资料齐套包</h3>
          <p>这是员工最终交付物。下载后按文件序号录入、上传和配置，不包含自动发布。</p>
        </div>
        <div className={`listing-materials-score ${ready ? "ready" : "blocked"}`}>
          <span>资料齐套率</span>
          <strong>
            {readiness?.score ?? "—"}
            <small>%</small>
          </strong>
        </div>
      </header>
      {readiness ? (
        <>
          <div className="listing-materials-track" aria-label="上架资料齐套进度">
            {readiness.groups.map((group, index) => (
              <div className={group.status} key={group.key}>
                <span>{String(index + 1).padStart(2, "0")}</span>
                <strong>{group.label}</strong>
                <small>
                  {group.completed}/{group.required}
                </small>
              </div>
            ))}
          </div>
          {readiness.issues.length ? (
            <div className="listing-materials-issues">
              <strong>完成以下资料后开放正式 ZIP</strong>
              <ul>
                {readiness.issues.map((issue) => (
                  <li key={`${issue.code}-${issue.path}`}>{issue.message}</li>
                ))}
              </ul>
            </div>
          ) : (
            <p className="listing-materials-ready">
              <CheckCircle2 size={16} />
              文案、图片、A+、Custom 配置、生产文件和合规资料已齐套。
            </p>
          )}
        </>
      ) : null}
      {error ? (
        <p className="listing-materials-error" role="alert">
          {error}
        </p>
      ) : null}
      <footer>
        <span>
          <PackageOpen aria-hidden="true" size={19} />
          <b>{ready ? "可交付给运营上架" : loading ? "正在核对全部资料" : "资料未齐，禁止交付"}</b>
        </span>
        <div>
          <button disabled={loading} onClick={() => void load()} type="button">
            <RefreshCw size={14} />
            重新检查
          </button>
          <a
            aria-disabled={!ready}
            href={ready ? `/v1/products/${planId}/listing-materials` : undefined}
          >
            <Download size={15} />
            下载完整上架资料包
          </a>
        </div>
      </footer>
    </section>
  );
}

function PanelHeader({ planId }: { planId: string }) {
  return (
    <header className="custom-package-header">
      <div>
        <p className="section-code">AMAZON CUSTOM / STUDIO HANDOFF</p>
        <h2 id="custom-package-title">Amazon Studio 产品包</h2>
      </div>
      <div className="custom-package-header-tools">
        <span className="mono">CUSTOMPRODUCTPACKAGEV1</span>
        <Link href={`/amazon-custom-sop?plan=${planId}#workflow-detail`}>
          <BookOpenCheck aria-hidden="true" size={14} />
          查看完整 SOP
        </Link>
      </div>
    </header>
  );
}

function TextField({
  inputMode,
  label,
  name,
  type = "text",
  value,
}: {
  inputMode?: "numeric";
  label: string;
  name: string;
  type?: "text" | "number";
  value?: string | number;
}) {
  return (
    <label className="custom-package-field">
      <span>{label}</span>
      <input
        defaultValue={value ?? ""}
        inputMode={inputMode}
        min={type === "number" ? 0 : undefined}
        name={name}
        step={type === "number" ? "any" : undefined}
        type={type}
      />
    </label>
  );
}

function TextArea({ label, name, value }: { label: string; name: string; value?: string }) {
  return (
    <label className="custom-package-field">
      <span>{label}</span>
      <textarea defaultValue={value ?? ""} name={name} rows={4} />
    </label>
  );
}

function StatusMetric({
  label,
  tone,
  value,
}: {
  label: string;
  tone: "ready" | "warning" | "neutral";
  value: number;
}) {
  return (
    <div className={`custom-package-metric ${tone}`}>
      <span>{label}</span>
      <strong className="mono">{value}</strong>
    </div>
  );
}

function ActionNotice({ state }: { state: CustomProductPackageActionState }) {
  return state.status === "idle" ? null : (
    <p
      className={`custom-package-notice ${state.status}`}
      role={state.status === "error" ? "alert" : "status"}
    >
      {state.message}
    </p>
  );
}

function collectFacts(profile: CustomProductProfileV1) {
  const facts = [
    profile.sku,
    profile.targetMarketplace,
    profile.productType,
    profile.brand,
    ...profile.materials,
    ...profile.colors,
    ...profile.sizeOptions,
    profile.packageQuantity,
    ...profile.packageContents,
    profile.manufacturingProcess,
    ...profile.targetAudiences,
    ...profile.sellingPoints,
    ...profile.surfaces,
  ];
  return facts.filter(Boolean) as Array<NonNullable<(typeof facts)[number]>>;
}

function releaseMissing(profile: CustomProductProfileV1) {
  return [
    !profile.sku && "缺少 SKU",
    !profile.targetMarketplace && "缺少 Amazon 站点",
    !profile.productType && "缺少产品类型",
    !profile.brand && "缺少品牌",
    !profile.materials.length && "缺少材质",
    !profile.sizeOptions.length && "缺少成品尺寸",
    !profile.packageQuantity && "缺少每包数量",
    !profile.packageContents.length && "缺少包装包含内容",
    !profile.manufacturingProcess && "缺少生产或印刷工艺",
    !profile.surfaces.length && "缺少定制面",
    profile.surfaces.some((surface) => !surface.areaMm) && "缺少定制区域宽高",
    profile.surfaces.some((surface) => !surface.fieldKeys.length) && "定制面尚未关联定制字段",
  ].filter((item): item is string => Boolean(item));
}
