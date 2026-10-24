"use client";
import { SpecificationFactsSchema, specificationFactProblems, specificationFactsReady } from "@yummyai/contracts/catalog/development";
import { SpecificationFactFields, specificationFactDraftKeys, specificationFactsDraft, specificationFactsFromDraft, type SpecificationFactDraft } from "./specification-fact-fields";
import { Fragment, useId, useState, type FormEvent } from "react";
import Link from "next/link";
import type {
  ArtworkView,
  SpecificationView,
  DevelopmentOptions,
} from "@yummyai/contracts/catalog/development";
import { modes } from "./development-client";
import { developmentRequest } from "./development-client";
import { ArtworkFieldsEditor } from "./artwork-fields-editor";
import { PrintBindingsEditor } from "./print-bindings-editor";
import { legacyPrintBinding, type PrintBinding } from "@yummyai/contracts/catalog/composition";
import { ArtworkAssetPicker } from "./artwork-asset-picker";
import type { CreativeRequirements, ArtworkMaterial } from "@yummyai/contracts/catalog/artwork";
import type { CustomizationDefinition } from "@yummyai/contracts";
import { useTaskDraft, clearTaskDrafts } from "../navigation/task-draft";
import { catalogDraftScope, writableDevelopmentOptions } from "./editor-access";
import { useErpAccess } from "../identity/erp-access";
import { useWorkflowReturn } from "../navigation/use-workflow-return";
import { workflowHref } from "../navigation/workflow-href";
import { useLeaveGuard } from "../navigation/use-leave-guard";
import { TaskDrawerActions, useInTaskDrawer } from "../navigation/task-drawer";
import { TeamSelect } from "../teams/team-select";
type Save = (body: Record<string, unknown>) => Promise<boolean>;
const string = (data: FormData, key: string) => String(data.get(key) ?? "").trim();

export function SpuForm({
  busy,
  onSave,
  value,
}: {
  busy: boolean;
  onSave: Save;
  value?: DevelopmentOptions["spus"][number];
}) {
  const [initial] = useState(value),
    [dirty, setDirty] = useState(false);
  const [teamId, setTeamId] = useState(value?.teamId ?? "");
  const formId = useId();
  const inDrawer = useInTaskDrawer();
  useLeaveGuard(dirty, busy, !inDrawer);
  return (
    <form
      id={formId}
      aria-label="SPU 基础信息"
      onChange={() => setDirty(true)}
      onSubmit={(e) => {
        e.preventDefault();
        const d = new FormData(e.currentTarget);
        void onSave({
          code: string(d, "code"),
          ...(teamId !== (initial?.teamId ?? "") ? { teamId: teamId || null } : {}),
          name: string(d, "name"),
          description: string(d, "description"),
          capabilities: {
            processes: string(d, "processes"),
            customizationScope: string(d, "customizationScope"),
            packaging: string(d, "packaging"),
          },
          ...(initial ? { expectedRevision: initial.revision } : {}),
        }).then((saved) => {
          if (saved) setDirty(false);
        });
      }}
    >
      <fieldset disabled={busy} className="pd-form">
        <TeamSelect initialValue={initial?.teamId} onChange={setTeamId} disabled={busy} />
        <label>
          SPU 编号
          <input
            name="code"
            defaultValue={initial?.code}
            required
            pattern="[A-Za-z0-9][A-Za-z0-9_.-]*"
            maxLength={100}
            placeholder="例如 PILLOW-01"
          />
        </label>
        <label>
          产品名称
          <input
            name="name"
            required
            maxLength={160}
            defaultValue={initial?.name}
            placeholder="例如 定制异形抱枕"
          />
        </label>
        <label className="pd-wide">
          产品说明
          <textarea
            name="description"
            aria-label="产品说明"
            defaultValue={initial?.description ?? ""}
            maxLength={3000}
            placeholder="填写这个产品的通用说明；尺寸、颜色在规格中分别维护。"
          />
        </label>
        <label className="pd-wide">
          可用加工工艺
          <textarea
            name="processes"
            defaultValue={initial?.capabilities?.processes ?? ""}
            maxLength={3000}
            placeholder="填写已确认的加工方法和限制；具体尺寸参数在规格中维护。"
          />
        </label>
        <label className="pd-wide">
          可定制范围
          <textarea
            name="customizationScope"
            defaultValue={initial?.capabilities?.customizationScope ?? ""}
            maxLength={3000}
            placeholder="例如支持文字、照片、固定印花；标明不能定制的部分。"
          />
        </label>
        <label className="pd-wide">
          通用包装要求
          <textarea
            name="packaging"
            defaultValue={initial?.capabilities?.packaging ?? ""}
            maxLength={2000}
          />
        </label>
        <TaskDrawerActions>
          <button form={formId} disabled={busy} className="oc-button primary">
            {busy ? "正在保存…" : initial ? "保存 SPU 基础信息" : "保存 SPU 并添加规格"}
          </button>
        </TaskDrawerActions>
      </fieldset>
    </form>
  );
}

export function ArtworkForm({
  options,
  value: suppliedValue,
  busy,
  onSave,
  initialCreativeVersionId,
  requirements,
}: {
  options: DevelopmentOptions;
  value: ArtworkView | null;
  busy: boolean;
  onSave: Save;
  initialCreativeVersionId?: string;
  requirements?: CreativeRequirements;
}) {
  const formId = useId();
  const [value] = useState(suppliedValue);
  const [mode, setMode] = useState<keyof typeof modes>(
    value?.mode ?? requirements?.mode ?? "fixed",
  );
  const [teamId, setTeamId] = useState(value?.teamId ?? "");
  const [customization, setCustomization] = useState<CustomizationDefinition>(
    value?.customization ?? requirements?.customization ?? { version: 1, fields: [] },
  );
  const [layout, setLayout] = useState(value?.layout ?? requirements?.layout ?? []);
  const [materials, setMaterials] = useState<
    Array<Pick<ArtworkMaterial, "assetId" | "role" | "usage">>
  >(value?.materials.filter((m) => m.role !== "master") ?? []);
  const [assetRefresh, setAssetRefresh] = useState<{
    basis: DevelopmentOptions["materialAssets"];
    assets: DevelopmentOptions["materialAssets"];
  } | null>(null);
  const materialAssets =
    assetRefresh?.basis === options.materialAssets ? assetRefresh.assets : options.materialAssets;
  const { localDevelopment } = useErpAccess();
  const [researchIds, setResearchIds] = useState(
    value?.researchItemIds ?? requirements?.researchItemIds ?? [],
  );
  const [creativeId, setCreativeId] = useState(
    value?.creativeVersionId ?? initialCreativeVersionId ?? "",
  );
  const unavailable =
    materials.some((material) => !materialAssets.some((asset) => asset.id === material.assetId)) ||
    researchIds.some((id) => !options.researchItems.some((item) => item.id === id)) ||
    Boolean(creativeId && !options.creativeVersions.some((version) => version.id === creativeId));
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (unavailable) return;
    const d = new FormData(e.currentTarget);
    await onSave({
      ...(teamId !== (value?.teamId ?? "") ? { teamId: teamId || null } : {}),
      code: string(d, "code"),
      name: string(d, "name"),
      mode,
      creativeVersionId: creativeId || null,
      researchItemIds: researchIds,
      tags: string(d, "tags")
        .split(/[，,]/)
        .map((s) => s.trim())
        .filter(Boolean),
      customization: mode === "fixed" ? { version: 1, fields: [] } : customization,
      layout: mode === "fixed" ? [] : layout,
      materials,
      instructions: string(d, "instructions"),
      expectedVersion: value?.version ?? 0,
    });
  }
  return (
    <form id={formId} onSubmit={submit}>
      <fieldset disabled={busy} className="pd-form">
        {unavailable && (
          <p role="alert">
            部分已选来源已不可用 请核对后重新选择{" "}
            <button
              type="button"
              className="oc-button"
              onClick={() => {
                setMaterials(
                  materials.filter((material) =>
                    materialAssets.some((asset) => asset.id === material.assetId),
                  ),
                );
                setResearchIds(
                  researchIds.filter((id) => options.researchItems.some((item) => item.id === id)),
                );
                if (!options.creativeVersions.some((version) => version.id === creativeId))
                  setCreativeId("");
              }}
            >
              清除失效来源
            </button>
          </p>
        )}
        <TeamSelect initialValue={value?.teamId} onChange={setTeamId} disabled={busy} />
        <label>
          印花 SKU
          <input
            name="code"
            required
            pattern="[A-Za-z0-9][A-Za-z0-9_.-]*"
            maxLength={100}
            readOnly={!!value}
            defaultValue={value?.code}
            placeholder="ART-PET-001"
          />
        </label>
        <label>
          印花名称
          <input name="name" required maxLength={160} defaultValue={value?.name} />
        </label>
        <label>
          已审核创意主文件
          <select
            name="creative"
            required={mode === "fixed"}
            value={creativeId}
            onChange={(e) => setCreativeId(e.target.value)}
          >
            <option value="">
              {mode === "fixed" ? "请选择" : "无固定主图（来图 / 文字定制）"}
            </option>
            {options.creativeVersions.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name} · V{v.version}
              </option>
            ))}
          </select>
          <small>固定印花需审核主文件；来图定制可留空，保留素材包与制作规则。</small>
        </label>
        <label>
          定制方式
          <select value={mode} onChange={(e) => setMode(e.target.value as keyof typeof modes)}>
            {Object.entries(modes).map(([key, name]) => (
              <option key={key} value={key}>
                {name}
              </option>
            ))}
          </select>
        </label>
        {mode !== "fixed" && (
          <div className="pd-span">
            <ArtworkFieldsEditor
              value={customization}
              layout={layout}
              onChange={(v, l) => {
                setCustomization(v);
                setLayout(l);
              }}
              previewPath={
                options.creativeVersions.find((v) => v.id === creativeId)
                  ? `/api/product-development/assets/${options.creativeVersions.find((v) => v.id === creativeId)!.assetId}/preview`
                  : undefined
              }
            />
          </div>
        )}
        <div className="pd-span">
          <h3>印花素材包</h3>
          <p className="canvas-help">
            固定主文件随已审核创意绑定。可补充分层 PSD、背景、装饰和字体；
            没有固定主图也可以保存素材包，订单按印花版本读取。
          </p>
          <ArtworkAssetPicker
            assets={materialAssets}
            selected={materials.map((m) => m.assetId)}
            onChange={(ids) =>
              setMaterials(
                ids.map(
                  (id) =>
                    materials.find((m) => m.assetId === id) ?? {
                      assetId: id,
                      role: "source",
                      usage: materialAssets.find((a) => a.id === id)?.fileName ?? "源文件",
                    },
                ),
              )
            }
            onRefresh={async () => {
              const o = await developmentRequest<DevelopmentOptions>("options");
              if (
                localDevelopment ||
                (options.contextAuthority !== undefined &&
                  o.contextAuthority === options.contextAuthority)
              )
                setAssetRefresh({ basis: options.materialAssets, assets: o.materialAssets });
            }}
          />
          {materials
            .filter((material) => materialAssets.some((asset) => asset.id === material.assetId))
            .map((m) => (
              <div key={m.assetId} className="art-material-row">
                <span>{materialAssets.find((a) => a.id === m.assetId)?.fileName ?? m.usage}</span>
                <label>
                  文件用途
                  <select
                    value={m.role}
                    onChange={(e) =>
                      setMaterials((v) =>
                        v.map((a) =>
                          a.assetId === m.assetId
                            ? { ...a, role: e.target.value as ArtworkMaterial["role"] }
                            : a,
                        ),
                      )
                    }
                  >
                    <option value="source">分层源文件</option>
                    <option value="background">背景</option>
                    <option value="decoration">装饰</option>
                    <option value="font">字体</option>
                    <option value="reference">参考说明</option>
                  </select>
                </label>
                <label>
                  制作说明
                  <input
                    value={m.usage}
                    maxLength={160}
                    required
                    onChange={(e) =>
                      setMaterials((v) =>
                        v.map((a) =>
                          a.assetId === m.assetId ? { ...a, usage: e.target.value } : a,
                        ),
                      )
                    }
                  />
                </label>
              </div>
            ))}
        </div>
        <label>
          标签（用逗号分隔）
          <input name="tags" defaultValue={value?.tags.join("，")} />
        </label>
        <label>
          研究来源
          <select
            name="research"
            multiple
            value={researchIds}
            onChange={(event) =>
              setResearchIds(
                Array.from(event.currentTarget.selectedOptions, (option) => option.value),
              )
            }
            size={4}
          >
            {options.researchItems.map((r) => (
              <option key={r.id} value={r.id}>
                {r.title}
              </option>
            ))}
          </select>
          <small>研究仅记录思路来源；登记使用审核过的原创主文件。</small>
        </label>
        <label>
          设计与使用说明
          <textarea
            name="instructions"
            required={!creativeId}
            defaultValue={
              value?.instructions ??
              [
                requirements?.fixedElements,
                requirements?.imageInstructions,
                requirements?.acceptance,
              ]
                .filter(Boolean)
                .join("\n")
            }
            rows={4}
          />
        </label>
        <div className="oc-actions pd-span">
          <TaskDrawerActions>
            <button
              form={formId}
              className="oc-button primary"
              disabled={
                busy || unavailable || (mode === "fixed" && !options.creativeVersions.length)
              }
            >
              {busy ? "保存中…" : value ? "保存新版本" : "登记印花"}
            </button>
          </TaskDrawerActions>
          <Link href="/creative-designs/canvas">前往创意项目审核文件</Link>
          {mode === "customer_image" && <small>买家图片在订单中单独保存。</small>}
        </div>
      </fieldset>
    </form>
  );
}

export function SpecificationForm({
  options,
  value: suppliedValue,
  busy,
  onSave,
  initialSpuId,
}: {
  options: DevelopmentOptions;
  value: SpecificationView | null;
  busy: boolean;
  onSave: Save;
  initialSpuId?: string;
}) {
  const formId = useId();
  const [value] = useState(suppliedValue);
  const workflow = useWorkflowReturn();
  const draftKey = `${catalogDraftScope(options)}:specification:${value?.versionId ?? initialSpuId ?? "new"}`;
  const [fields, setFields, recoveryError] = useTaskDraft<Record<string, string[]>>(draftKey, "fields", {}, { session: true, validate: (value): value is Record<string, string[]> => !!value && typeof value === "object" && !Array.isArray(value) && Object.values(value).every(row => Array.isArray(row) && row.every(item => typeof item === "string")) });
  const field = (name: string, fallback?: string | number) => fields[name]?.[0] ?? fallback;
  const references = {
    process: String(field("process", value?.processProfileVersionId ?? "")),
    canvas: String(field("canvas", value?.canvasPrintSpecVersionId ?? "")),
    stock: String(field("stock", value?.stockItemId ?? "")),
  };
  const missingReferences = new Set(
    [
      references.process && !options.processes.some((item) => item.versionId === references.process)
        ? "process"
        : "",
      references.canvas && !options.canvasPrintSpecs.some((item) => item.id === references.canvas)
        ? "canvas"
        : "",
      references.stock && !options.stockItems.some((item) => item.id === references.stock)
        ? "stock"
        : "",
    ].filter(Boolean),
  );
  const [error, setError] = useState("");
  const initialFacts = specificationFactsDraft(value?.facts);
  const factValues = Object.fromEntries(specificationFactDraftKeys.map(key => [key, String(field(key, fields[key === "packageContents" ? "contents" : key === "packageQuantity" ? "quantity" : key]?.[0] ?? initialFacts[key]) ?? "")])) as SpecificationFactDraft;
  const confirmed = !recoveryError && (fields._captured ? !!fields.confirmed?.length : !!value && specificationFactsReady(value.facts));
  const changeReference = (reference: keyof typeof references, next: string) =>
    setFields((current) => ({ ...current, [reference]: [next] }));
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (missingReferences.size) return;
    const d = new FormData(e.currentTarget);
    const attributeValues = d.getAll("attribute-value");
    const pairs = d
      .getAll("attribute-name")
      .map((key, index) => [String(key).trim(), String(attributeValues[index] ?? "").trim()]);
    if (
      pairs.some((p) => p.length !== 2 || !p[0] || !p[1]) ||
      new Set(pairs.map((p) => p[0])).size !== pairs.length
    ) {
      setError("请补齐属性名称和选项，属性名称不可重复");
      return;
    }
    setError("");
    const draft = Object.fromEntries(specificationFactDraftKeys.map(key => [key, d.has(key) ? string(d, key) : factValues[key]])) as SpecificationFactDraft;
    const checked = SpecificationFactsSchema.safeParse(specificationFactsFromDraft(draft, confirmed));
    if (!checked.success) { setError("规格事实的数值或格式无效 请检查测量值和件数"); return; }
    const problems = confirmed ? specificationFactProblems(checked.data) : [];
    if (problems.length) { setError(problems.join("；")); return; }
    const saved = await onSave({
      spuId: string(d, "spu"),
      code: string(d, "code"),
      name: string(d, "name"),
      attributes: Object.fromEntries(pairs),
      facts: checked.data,
      processProfileVersionId: string(d, "process") || null,
      canvasPrintSpecVersionId: string(d, "canvas") || null,
      stockItemId: string(d, "stock") || null,
      expectedVersion: value?.version ?? 0,
    });
    if (saved) clearTaskDrafts(draftKey);
  }
  return (
    <form
      id={formId}
      onSubmit={submit}
      onChangeCapture={(event) => {
        const data = new FormData(event.currentTarget);
        if (event.target.getAttribute("name") !== "confirmed") data.delete("confirmed");
        setFields(
          Object.fromEntries([
            ...[...data.keys()].map((key) => [key, data.getAll(key).map(String)]),
            ["_captured", ["1"]],
          ]),
        );
      }}
    >
      {error && <p role="alert">{error}</p>}
      {recoveryError && <p role="alert">{recoveryError}</p>}
      {missingReferences.size > 0 && (
        <p role="alert" className="oc-error">
          关联资料已不可用 请重新选择或明确清除关联
        </p>
      )}
      <fieldset disabled={busy} className="pd-form">
        <label>
          商品 SPU
          <select
            name="spu"
            required
            defaultValue={field("spu", value?.spuId ?? initialSpuId ?? "")}
            onChange={
              value
                ? (e) => {
                    e.target.value = value.spuId;
                  }
                : undefined
            }
          >
            <option value="">请选择</option>
            {options.spus
              .filter(
                (s) => !(value?.spuId ?? initialSpuId) || s.id === (value?.spuId ?? initialSpuId),
              )
              .map((s) => (
                <option key={s.id} value={s.id}>
                  {s.code} · {s.name}
                </option>
              ))}
          </select>
        </label>
        <label>
          规格编号
          <input
            name="code"
            required
            pattern="[A-Za-z0-9][A-Za-z0-9_.-]*"
            readOnly={!!value}
            defaultValue={field("code", value?.code)}
            placeholder="WHITE-50X60"
          />
        </label>
        <label>
          规格名称
          <input
            name="name"
            required
            defaultValue={field("name", value?.name)}
            placeholder="白色 · 50×60 英寸"
          />
        </label>
        <SpecificationAttributesEditor
          draftKey={draftKey}
          attributes={value?.attributes ?? { 尺寸: "" }}
        />
        {value && value.facts.formatVersion !== 2 && <p className="pd-form-hint pd-span">旧规格保留原记录 请核对原尺寸说明 {value.facts.dimensions} 再填写明确的口径 测量值与核验依据</p>}
        <SpecificationFactFields values={factValues} onChange={patch => setFields(current => ({ ...current, ...Object.fromEntries(Object.entries(patch).map(([key, next]) => [key, [next]])), confirmed: [], _captured: ["1"] }))} />
        <label>
          通用工艺底稿
          <select
            name="process"
            value={references.process}
            onChange={(event) => changeReference("process", event.currentTarget.value)}
          >
            <option value="">待配置（保存为规格草稿）</option>
            {missingReferences.has("process") && (
              <option value={references.process} disabled>
                原工艺当前不可用 需重新选择
              </option>
            )}
            {options.processes.map((p) => (
              <option key={p.versionId} value={p.versionId}>
                {p.code} · {p.name}
              </option>
            ))}
          </select>
          <small>可先保存规格草稿；确认工艺底稿与产品事实后才能用于订单制作。</small>
        </label>
        <label>
          套图印刷规格
          <select
            name="canvas"
            value={references.canvas}
            onChange={(event) => changeReference("canvas", event.currentTarget.value)}
          >
            <option value="">暂不设置（套图前需补齐）</option>
            {missingReferences.has("canvas") && (
              <option value={references.canvas} disabled>
                原印刷规格当前不可用 需重新选择
              </option>
            )}
            {options.canvasPrintSpecs.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          共用空白品库存物料
          <select
            name="stock"
            value={references.stock}
            onChange={(event) => changeReference("stock", event.currentTarget.value)}
          >
            <option value="">暂不关联</option>
            {missingReferences.has("stock") && (
              <option value={references.stock} disabled>
                原库存物料当前不可用 需重新选择
              </option>
            )}
            {options.stockItems.map((i) => (
              <option key={i.id} value={i.id}>
                {i.code} · {i.name}
              </option>
            ))}
          </select>
        </label>
        <label className="oc-check">
          <input
            type="checkbox"
            name="confirmed"
            checked={confirmed}
            onChange={event => setFields(current => ({ ...current, confirmed: event.target.checked ? ["on"] : [], _captured: ["1"] }))}
          />
          已核实材质、尺寸和包装内容
        </label>
        <div className="oc-actions pd-span">
          <TaskDrawerActions>
            <button
              form={formId}
              className="oc-button primary"
              disabled={busy || missingReferences.size > 0 || !options.spus.length}
            >
              {busy ? "保存中…" : value ? "保存新版本" : "保存规格"}
            </button>
          </TaskDrawerActions>
          <Link
            data-task-draft-link
            href={workflowHref("/product-specifications", workflow.current)}
          >
            管理 SPU
          </Link>
          <Link data-task-draft-link href={workflowHref("/process-library", workflow.current)}>
            登记工艺底稿
          </Link>
        </div>
      </fieldset>
    </form>
  );
}

function SpecificationAttributesEditor({
  attributes,
  draftKey,
}: {
  attributes: Record<string, string>;
  draftKey: string;
}) {
  const [pairs, setPairs, recoveryError] = useTaskDraft(draftKey, "attributes", () => Object.entries(attributes), { session: true, validate: (value): value is Array<[string, string]> => Array.isArray(value) && value.every(pair => Array.isArray(pair) && pair.length === 2 && pair.every(item => typeof item === "string")) });
  return (
    <div className="pd-span pd-option-section">
      <h3>当前规格的选项</h3>
      {recoveryError && <p role="alert">{recoveryError}</p>}
      <p>每个规格对应一组确定的选项。增加其他尺寸或形状，请使用页面上的“绑定多个规格”。</p>
      {pairs.map(([name, value], index) => (
        <div className="pd-option-axis" key={index}>
          <label>
            属性名称
            <input
              name="attribute-name"
              aria-label={`属性名称 ${index + 1}`}
              maxLength={80}
              required
              value={name}
              onChange={(event) =>
                setPairs((current) =>
                  current.map((pair, i) => (i === index ? [event.target.value, pair[1]!] : pair)),
                )
              }
            />
          </label>
          <label className="pd-option-values">
            选项
            <input
              name="attribute-value"
              aria-label={`属性选项 ${index + 1}`}
              maxLength={200}
              required
              value={value}
              onChange={(event) =>
                setPairs((current) =>
                  current.map((pair, i) => (i === index ? [pair[0]!, event.target.value] : pair)),
                )
              }
            />
          </label>
          <button
            type="button"
            className="oc-button pd-axis-remove"
            aria-label={`删除属性 ${index + 1}`}
            onClick={() => setPairs((current) => current.filter((_, i) => i !== index))}
          >
            ×
          </button>
        </div>
      ))}
      <button
        type="button"
        className="oc-button"
        onClick={() => setPairs((current) => [...current, ["", ""]])}
      >
        添加属性
      </button>
    </div>
  );
}

export function CombinationForm({
  options: suppliedOptions,
  busy,
  onSave,
  legacy,
  initialArtworkVersionId,
}: {
  options: DevelopmentOptions;
  busy: boolean;
  onSave: Save;
  legacy?: { skuId: string; skuCode: string; spuId: string };
  initialArtworkVersionId?: string;
}) {
  const formId = useId();
  const { can } = useErpAccess();
  const options = writableDevelopmentOptions(suppliedOptions, can);
  const workflow = useWorkflowReturn();
  const draftKey = `${catalogDraftScope(options)}:combination:${legacy?.skuId ?? initialArtworkVersionId ?? "new"}`;
  const [bindings, setBindings] = useTaskDraft<PrintBinding[]>(draftKey, "printBindings", []);
  const [artworkId, setArtworkId] = useTaskDraft(draftKey, "artwork", () =>
      options.artworks.some((a) => a.versionId === initialArtworkVersionId)
        ? initialArtworkVersionId!
        : "",
    ),
    [chosen, setChosen] = useTaskDraft<string[]>(draftKey, "chosen", []),
    [codes, setCodes] = useTaskDraft<Record<string, string>>(draftKey, "codes", {});
  const artwork = options.artworks.find(
      (a) => a.versionId === (bindings[0]?.artworkVersionId ?? artworkId),
    ),
    specs = options.spus.flatMap((spu) =>
      options.specifications.filter(
        (s) => s.spuId === spu.id && (!legacy || s.spuId === legacy.spuId),
      ),
    );
  const skuCode = (s: SpecificationView) =>
    codes[s.versionId] ?? legacy?.skuCode ?? `${artwork?.code ?? "ART"}-${s.spuCode}-${s.code}`;
  const unavailable =
    chosen.some((id) => !specs.some((spec) => spec.versionId === id)) ||
    (bindings.length
      ? bindings.some(
          (binding) => !options.artworks.some((art) => art.versionId === binding.artworkVersionId),
        )
      : Boolean(artworkId && !options.artworks.some((art) => art.versionId === artworkId)));
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (unavailable || !chosen.length || !artworkId) return;
    const saved = await onSave({
      ...(bindings.length ? { printBindings: bindings } : { artworkVersionId: artworkId }),
      items: specs
        .filter((s) => chosen.includes(s.versionId))
        .map((s) => ({
          specificationVersionId: s.versionId,
          skuCode: skuCode(s),
          ...(legacy ? { existingSkuId: legacy.skuId } : {}),
        })),
    });
    if (saved) clearTaskDrafts(draftKey);
  }
  return (
    <form id={formId} onSubmit={submit}>
      <fieldset disabled={busy} className="pd-combine">
        {unavailable && (
          <p role="alert">
            部分已选资料已不可用 请重新选择后生成{" "}
            <button
              type="button"
              className="oc-button"
              onClick={() => {
                setChosen(chosen.filter((id) => specs.some((spec) => spec.versionId === id)));
                setBindings([]);
                setArtworkId("");
              }}
            >
              清除失效选择
            </button>
          </p>
        )}
        {initialArtworkVersionId &&
          !options.artworks.some((a) => a.versionId === initialArtworkVersionId) && (
            <p role="alert">来源印花版本当前不可用，请核对后重新选择。</p>
          )}
        <label>
          选择独立印花
          <select
            required={!bindings.length}
            disabled={bindings.length > 0}
            value={artworkId}
            onChange={(e) => setArtworkId(e.target.value)}
          >
            <option value="">请选择印花版本</option>
            {options.artworks.map((a) => (
              <option key={a.versionId} value={a.versionId}>
                {a.code} · {a.name} · V{a.version}
              </option>
            ))}
          </select>
        </label>
        <p>
          选择产品规格，并核对生成的销售 SKU 编号。
          {legacy ? "此操作只补充旧 SKU 的明确映射。" : "同一印花可以同时组合多个 SPU。"}
        </p>
        <label className="oc-check">
          <input
            type="checkbox"
            checked={bindings.length > 0}
            disabled={!artworkId && !bindings.length}
            onChange={(e) => setBindings(e.target.checked ? [legacyPrintBinding(artworkId)] : [])}
          />
          为同一商品配置多个印花、制作面或区域
        </label>
        {bindings.length > 0 && (
          <PrintBindingsEditor
            bindings={bindings}
            artworks={options.artworks}
            onChange={setBindings}
          />
        )}
        <div className="pd-table">
          <table>
            <thead>
              <tr>
                <th>选择</th>
                <th>SPU / 规格</th>
                <th>销售 SKU 编号</th>
              </tr>
            </thead>
            <tbody>
              {specs.map((s, index) => (
                <Fragment key={s.versionId}>
                  {(index === 0 || specs[index - 1]?.spuId !== s.spuId) && (
                    <tr className="pd-spu-group">
                      <th colSpan={3} scope="rowgroup">
                        {s.spuCode} · {s.spuName}
                      </th>
                    </tr>
                  )}
                  <tr>
                    <td>
                      <input
                        aria-label={`选择 ${s.spuCode} ${s.code}`}
                        type={legacy ? "radio" : "checkbox"}
                        checked={chosen.includes(s.versionId)}
                        onChange={(e) =>
                          setChosen(
                            legacy
                              ? [s.versionId]
                              : e.target.checked
                                ? [...chosen, s.versionId]
                                : chosen.filter((id) => id !== s.versionId),
                          )
                        }
                      />
                    </td>
                    <td>
                      {s.name}
                      <small>{s.code}</small>
                    </td>
                    <td>
                      <input
                        aria-label={`${s.spuCode} ${s.code} 销售 SKU`}
                        disabled={!chosen.includes(s.versionId)}
                        required={chosen.includes(s.versionId)}
                        readOnly={!!legacy}
                        pattern="[A-Za-z0-9][A-Za-z0-9_.-]*"
                        maxLength={100}
                        value={skuCode(s)}
                        onChange={(e) => setCodes({ ...codes, [s.versionId]: e.target.value })}
                      />
                    </td>
                  </tr>
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
        {!specs.length && (
          <p>
            尚无可组合的规格，请先到{" "}
            <Link
              data-task-draft-link
              href={workflowHref("/product-specifications", workflow.current)}
            >
              SPU 与规格
            </Link>{" "}
            登记，完成后返回原任务。
          </p>
        )}
        <TaskDrawerActions>
          <button
            form={formId}
            className="oc-button primary"
            disabled={busy || unavailable || !artworkId || !chosen.length || chosen.length > 50}
          >
            {busy ? "正在保存…" : legacy ? "确认映射" : `生成 ${chosen.length} 个销售 SKU`}
          </button>
        </TaskDrawerActions>
      </fieldset>
    </form>
  );
}
