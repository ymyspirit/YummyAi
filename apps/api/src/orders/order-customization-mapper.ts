import {
  CustomizationSchema,
  type CustomizationDefinition,
  type CustomizationField,
  type OrderCustomizationValue,
} from "@yummyai/contracts";

export interface MappedCustomizationResult {
  values: Record<string, string | string[]>;
  fileReferences: Array<{ fieldKey: string; externalReference: string }>;
  mappedFieldKeys: string[];
  missingFieldKeys: string[];
  unmappedSourceLabels: string[];
  diagnostics: Array<{ code: "invalid_value" | "duplicate_value" | "unmapped_value"; fieldKey: string | null }>;
  completeness: number;
}

export function mapOrderCustomization(
  rawSchema: CustomizationDefinition,
  sourceValues: readonly OrderCustomizationValue[],
): MappedCustomizationResult {
  const schema = CustomizationSchema.parse(rawSchema);
  const values: Record<string, string | string[]> = {};
  const files: MappedCustomizationResult["fileReferences"] = [];
  const diagnostics: MappedCustomizationResult["diagnostics"] = [];
  const mapped = new Set<string>();
  const unmappedSourceLabels: string[] = [];

  for (const source of sourceValues) {
    const field = findField(schema.fields, source.key, source.label);
    if (!field) {
      unmappedSourceLabels.push(source.label);
      diagnostics.push({ code: "unmapped_value", fieldKey: null });
      continue;
    }
    if (mapped.has(field.key)) {
      diagnostics.push({ code: "duplicate_value", fieldKey: field.key });
      continue;
    }
    const normalized = normalizeValue(field, source);
    if (!normalized) {
      diagnostics.push({ code: "invalid_value", fieldKey: field.key });
      continue;
    }
    mapped.add(field.key);
    if (normalized.kind === "file") files.push({ fieldKey: field.key, externalReference: normalized.value });
    else values[field.key] = normalized.value;
  }

  const required = schema.fields.filter((field) => field.required && isVisible(field, values));
  const missingFieldKeys = required.filter((field) => !mapped.has(field.key)).map((field) => field.key);
  const completeness = required.length === 0 ? 100 : Math.round(((required.length - missingFieldKeys.length) / required.length) * 100);
  return {
    values,
    fileReferences: files,
    mappedFieldKeys: [...mapped].sort(),
    missingFieldKeys,
    unmappedSourceLabels,
    diagnostics,
    completeness,
  };
}

function findField(fields: CustomizationField[], key: string, label: string) {
  const sourceCandidates = new Set([normalizeIdentity(key), normalizeIdentity(label)]);
  return fields.find((field) => sourceCandidates.has(normalizeIdentity(field.key)) || sourceCandidates.has(normalizeIdentity(field.label)));
}

function normalizeValue(field: CustomizationField, source: OrderCustomizationValue): { kind: "value"; value: string | string[] } | { kind: "file"; value: string } | null {
  if (field.type === "image") return source.type === "file_reference" ? { kind: "file", value: source.externalReference } : null;
  if (source.type === "file_reference") return null;
  const entries = source.type === "choice" ? source.values : [source.value];
  if (field.type === "short_text" || field.type === "long_text") {
    const value = entries.join(", ");
    const minimum = field.validation?.minLength ?? 0;
    const maximum = field.validation?.maxLength ?? (field.type === "short_text" ? 500 : 10_000);
    if (value.length < minimum || value.length > maximum) return null;
    if (field.validation?.pattern && !matchesPattern(value, field.validation.pattern)) return null;
    return { kind: "value", value };
  }
  if (field.type === "single_choice") {
    const option = field.options.find((candidate) => entries.some((entry) => normalizeIdentity(entry) === normalizeIdentity(candidate.value) || normalizeIdentity(entry) === normalizeIdentity(candidate.label)));
    return option ? { kind: "value", value: option.value } : null;
  }
  if (field.type === "multiple_choice") {
    const selected = field.options.filter((candidate) => entries.some((entry) => normalizeIdentity(entry) === normalizeIdentity(candidate.value) || normalizeIdentity(entry) === normalizeIdentity(candidate.label))).map((option) => option.value);
    const minimum = field.minSelections ?? 0;
    const maximum = field.maxSelections ?? field.options.length;
    return selected.length >= minimum && selected.length <= maximum && selected.length === entries.length ? { kind: "value", value: selected } : null;
  }
  if (field.type === "date") {
    const value = entries[0] ?? "";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
    if (field.minDate && value < field.minDate || field.maxDate && value > field.maxDate) return null;
    return { kind: "value", value };
  }
  if (field.type === "color") {
    const value = entries[0] ?? "";
    const color = field.palette.find((candidate) => candidate.toLowerCase() === value.toLowerCase());
    return color ? { kind: "value", value: color } : null;
  }
  return null;
}

function isVisible(field: CustomizationField, values: Record<string, string | string[]>): boolean {
  if (!field.visibleWhen) return true;
  const actual = values[field.visibleWhen.fieldKey];
  const expected = field.visibleWhen.value;
  if (field.visibleWhen.operator === "not_empty") return Array.isArray(actual) ? actual.length > 0 : Boolean(actual);
  const comparable = Array.isArray(actual) ? actual : actual === undefined ? [] : [actual];
  const expectedValues = Array.isArray(expected) ? expected.map(String) : expected === undefined ? [] : [String(expected)];
  if (field.visibleWhen.operator === "contains") return expectedValues.some((value) => comparable.includes(value));
  const equals = comparable.length === expectedValues.length && comparable.every((value) => expectedValues.includes(value));
  return field.visibleWhen.operator === "equals" ? equals : !equals;
}

function normalizeIdentity(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

function matchesPattern(value: string, pattern: string): boolean {
  try { return new RegExp(pattern, "u").test(value); } catch { return false; }
}
