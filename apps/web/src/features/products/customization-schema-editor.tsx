"use client";

import type { CustomizationDefinition, CustomizationField } from "@yummyai/contracts";
import { Braces, Plus, Trash2 } from "lucide-react";
import { useState } from "react";

type FieldType = CustomizationField["type"];

export function CustomizationSchemaEditor({
  initialSchema,
  onChange,
}: {
  initialSchema: CustomizationDefinition;
  onChange?: (schema: CustomizationDefinition) => void;
}) {
  const [schema, setSchema] = useState(initialSchema);
  const [newType, setNewType] = useState<FieldType>("short_text");
  const issues = validateCustomizationSchema(schema);
  const isValid = issues.length === 0;

  function commit(next: CustomizationDefinition) {
    setSchema(next);
    if (validateCustomizationSchema(next).length === 0) onChange?.(next);
  }

  function addField() {
    const number = schema.fields.length + 1;
    commit({ ...schema, fields: [...schema.fields, defaultField(newType, number)] });
  }

  return (
    <section className="customization-editor" aria-labelledby="customization-title">
      <header>
        <div><p className="section-code">CUSTOMIZATION SCHEMA · V{schema.version}</p><h2 id="customization-title">客户定制字段</h2><p>字段条件只引用本 Schema，生产映射保留到后续工艺系统。</p></div>
        <span className={`schema-health ${isValid ? "schema-valid" : "schema-invalid"}`}><Braces size={14} />{isValid ? "Schema 有效" : "需要修正"}</span>
      </header>
      <ol className="custom-field-list">
        {schema.fields.map((field, index) => (
          <li key={`${field.key}-${index}`}>
            <div className="field-index mono">F{String(index + 1).padStart(2, "0")}</div>
            <div className="field-grid">
              <label>字段键<input value={field.key} onChange={(event) => commit(updateField(schema, index, { key: event.target.value }))} /></label>
              <label>客户标签<input value={field.label} onChange={(event) => commit(updateField(schema, index, { label: event.target.value }))} /></label>
              <label>字段类型<input value={fieldTypeLabel(field.type)} readOnly /></label>
              <label>显示条件<select value={field.visibleWhen?.fieldKey ?? ""} onChange={(event) => commit(updateVisibility(schema, index, event.target.value))}><option value="">始终显示</option>{schema.fields.filter((candidate) => candidate.key !== field.key).map((candidate) => <option value={candidate.key} key={candidate.key}>{candidate.label}</option>)}</select></label>
            </div>
            <div className="field-actions">
              <label className="required-toggle"><input type="checkbox" checked={field.required} onChange={(event) => commit(updateField(schema, index, { required: event.target.checked }))} />必填</label>
              <button type="button" onClick={() => commit({ ...schema, fields: schema.fields.filter((_, fieldIndex) => fieldIndex !== index) })} aria-label={`删除字段 ${field.label}`}><Trash2 size={15} /></button>
            </div>
          </li>
        ))}
      </ol>
      {!schema.fields.length && <div className="customization-empty"><Braces size={22} /><strong>尚未定义定制字段</strong><p>从文字、图片、日期、颜色或选择字段开始。</p></div>}
      <div className="field-add-bar">
        <label>新增类型<select value={newType} onChange={(event) => setNewType(event.target.value as FieldType)}>{fieldTypes.map((type) => <option value={type} key={type}>{fieldTypeLabel(type)}</option>)}</select></label>
        <button type="button" onClick={addField}><Plus size={16} />添加字段</button>
      </div>
      {!isValid && <ul className="schema-errors" role="alert">{issues.slice(0, 4).map((issue) => <li key={issue}>{issue}</li>)}</ul>}
    </section>
  );
}

export function isCustomizationFieldVisible(field: CustomizationField, values: Readonly<Record<string, unknown>>): boolean {
  const condition = field.visibleWhen;
  if (!condition) return true;
  const current = values[condition.fieldKey];
  if (condition.operator === "not_empty") return current !== undefined && current !== null && current !== "" && (!Array.isArray(current) || current.length > 0);
  if (condition.operator === "equals") return current === condition.value;
  if (condition.operator === "not_equals") return current !== condition.value;
  if (typeof current === "string") return current.includes(String(condition.value ?? ""));
  if (Array.isArray(current)) return current.includes(condition.value);
  return false;
}

const fieldTypes: FieldType[] = ["short_text", "long_text", "image", "date", "color", "single_choice", "multiple_choice"];

function updateField(schema: CustomizationDefinition, index: number, patch: Partial<CustomizationField>): CustomizationDefinition {
  return { ...schema, fields: schema.fields.map((field, fieldIndex) => fieldIndex === index ? { ...field, ...patch } as CustomizationField : field) };
}

function updateVisibility(schema: CustomizationDefinition, index: number, fieldKey: string): CustomizationDefinition {
  return updateField(schema, index, { visibleWhen: fieldKey ? { fieldKey, operator: "not_empty" } : undefined });
}

function defaultField(type: FieldType, number: number): CustomizationField {
  const core = { key: `field_${number}`, label: `定制字段 ${number}`, required: false };
  if (type === "image") return { ...core, type, validation: { allowedMediaTypes: ["image/png", "image/jpeg"], maxFiles: 1, maxBytes: 10_000_000 } };
  if (type === "color") return { ...core, type, palette: ["#1E3A5F", "#A16207"] };
  if (type === "single_choice") return { ...core, type, options: [{ value: "option_1", label: "选项 1" }] };
  if (type === "multiple_choice") return { ...core, type, options: [{ value: "option_1", label: "选项 1" }], minSelections: 0 };
  return { ...core, type };
}

function fieldTypeLabel(type: FieldType) {
  return ({ short_text: "短文本", long_text: "长文本", image: "图片", date: "日期", color: "颜色", single_choice: "单选", multiple_choice: "多选" })[type];
}

function validateCustomizationSchema(schema: CustomizationDefinition): string[] {
  const issues: string[] = [];
  const keys = new Set<string>();
  schema.fields.forEach((field, index) => {
    const path = `fields.${index}`;
    if (!/^[a-z][a-z0-9_]{0,79}$/.test(field.key)) issues.push(`${path}.key: 仅允许小写字母、数字和下划线`);
    if (keys.has(field.key)) issues.push(`${path}.key: 字段键必须唯一`);
    keys.add(field.key);
    if (!field.label.trim()) issues.push(`${path}.label: 客户标签不能为空`);
    if ((field.type === "single_choice" || field.type === "multiple_choice") && field.options.length === 0) issues.push(`${path}.options: 至少需要一个选项`);
    if (field.type === "color" && field.palette.length === 0) issues.push(`${path}.palette: 至少需要一种颜色`);
  });
  schema.fields.forEach((field, index) => {
    if (field.visibleWhen && (!keys.has(field.visibleWhen.fieldKey) || field.visibleWhen.fieldKey === field.key)) {
      issues.push(`fields.${index}.visibleWhen.fieldKey: 显示条件必须引用另一个现有字段`);
    }
  });
  return issues;
}
