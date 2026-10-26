import {
  CustomizationSchema,
  type CustomizationDefinition,
  type CustomizationField,
  type OrderCustomizationValue,
} from "@yummyai/contracts";
import { pillowCropSubject, pillowPrintSide } from "@yummyai/contracts/order/production-requirements";

/** Only the caller's validated shaped-pillow, photo-only artwork may opt in. */
export interface OrderCustomizationMappingOptions {
  photoOnlyPillow?: boolean;
}

export interface MappedCustomizationResult {
  values: Record<string, string | string[]>;
  fileReferences: Array<{ fieldKey: string; externalReference: string }>;
  mappedFieldKeys: string[];
  missingFieldKeys: string[];
  unmappedSourceLabels: string[];
  diagnostics: Array<{ code: "invalid_value" | "duplicate_value" | "unmapped_value" | "ambiguous_field"; fieldKey: string | null }>;
  completeness: number;
}

export function mapOrderCustomization(
  rawSchema: CustomizationDefinition,
  sourceValues: readonly OrderCustomizationValue[],
  options: OrderCustomizationMappingOptions = {},
): MappedCustomizationResult {
  const schema = CustomizationSchema.parse(rawSchema);
  const values: Record<string, string | string[]> = {};
  const files: MappedCustomizationResult["fileReferences"] = [];
  const diagnostics: MappedCustomizationResult["diagnostics"] = [];
  const mapped = new Set<string>();
  const seen = new Set<string>();
  const unmappedSourceLabels: string[] = [];

  for (const source of sourceValues) {
    const candidates = customizationFieldCandidates(schema.fields, source.key, source.label, options);
    if (candidates.length > 1) {
      diagnostics.push({ code: "ambiguous_field", fieldKey: null });
      unmappedSourceLabels.push(source.label);
      continue;
    }
    const field = candidates[0];
    if (!field) {
      unmappedSourceLabels.push(source.label);
      diagnostics.push({ code: "unmapped_value", fieldKey: null });
      continue;
    }
    if (seen.has(field.key)) {
      diagnostics.push({ code: "duplicate_value", fieldKey: field.key });
      mapped.delete(field.key);
      delete values[field.key];
      const fileIndex = files.findIndex(file => file.fieldKey === field.key);
      if (fileIndex >= 0) files.splice(fileIndex, 1);
      continue;
    }
    seen.add(field.key);
    const normalized = normalizeValue(field, source, options);
    if (!normalized) {
      diagnostics.push({ code: "invalid_value", fieldKey: field.key });
      continue;
    }
    mapped.add(field.key);
    if (normalized.kind === "file") files.push({ fieldKey: field.key, externalReference: normalized.value });
    else values[field.key] = normalized.value;
  }

  const required = schema.fields.filter((field) => field.required && customizationFieldVisible(field, values));
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

export function customizationFieldCandidates(
  fields: CustomizationField[],
  key: string,
  label: string,
  options: OrderCustomizationMappingOptions = {},
) {
  const exact = fields.find(field => field.key === key);
  if (exact) {
    const directLabelMatches = fields.filter(field => [normalizeIdentity(field.key), normalizeIdentity(field.label)].includes(normalizeIdentity(label)));
    const labelMatches = directLabelMatches.length ? directLabelMatches : pillowAliasCandidates(fields, label, options);
    // A canonical key disambiguates shared labels. A label pointing solely at
    // another field is contradictory and must still be reviewed.
    return labelMatches.length && !labelMatches.some(field => field.key === exact.key)
      ? [exact, ...labelMatches] : [exact];
  }
  const sourceCandidates = new Set([normalizeIdentity(key), normalizeIdentity(label)].filter(Boolean));
  const direct = fields.filter((field) => sourceCandidates.has(normalizeIdentity(field.key)) || sourceCandidates.has(normalizeIdentity(field.label)));
  if (direct.length) return direct;
  return [...new Map([key, label].flatMap(value => pillowAliasCandidates(fields, value, options)).map(field => [field.key, field])).values()];
}

function pillowAliasCandidates(fields: CustomizationField[], source: string, options: OrderCustomizationMappingOptions) {
  if (!options.photoOnlyPillow) return [];
  const identity = normalizeIdentity(source);
  if (identity === "正面" || identity === "uploadoneclearphoto") {
    const images = fields.filter(field => field.type === "image");
    return images.length === 1 && images[0]!.key === "buyer_photo" ? images : [];
  }
  const target = ({ pillowshape: "crop_scope", style: "print_sides", ordernotesforseller: "customer_notes" } as Record<string, string>)[identity];
  return target ? fields.filter(field => field.key === target) : [];
}

function pillowChoice(
  field: Extract<CustomizationField, { type: "single_choice" }>,
  entry: string,
  semantic: (value: string) => string | null,
) {
  const meaning = (option: { value: string; label: string }) => {
    const value = semantic(option.value), label = semantic(option.label);
    return value && label && value !== label ? null : value ?? label;
  };
  const exact = field.options.filter(option =>
    normalizeIdentity(entry) === normalizeIdentity(option.value) || normalizeIdentity(entry) === normalizeIdentity(option.label));
  if (exact.length) {
    if (exact.length !== 1) return null;
    const option = exact[0]!, target = meaning(option), supplied = semantic(entry);
    return target && (!supplied || supplied === target) ? { kind: "value" as const, value: option.value } : null;
  }
  const expected = semantic(entry);
  if (!expected) return null;
  const matches = field.options.filter(option => meaning(option) === expected);
  return matches.length === 1 ? { kind: "value" as const, value: matches[0]!.value } : null;
}

function normalizeValue(field: CustomizationField, source: OrderCustomizationValue, options: OrderCustomizationMappingOptions): { kind: "value"; value: string | string[] } | { kind: "file"; value: string } | null {
  if (field.type === "image") return source.type === "file_reference" ? { kind: "file", value: source.externalReference } : null;
  if (source.type === "file_reference") return null;
  const entries = source.type === "choice" ? [...source.values] : [source.value];
  if (options.photoOnlyPillow && (field.key === "crop_scope" || field.key === "print_sides")) {
    if (entries.length !== 1) return null;
    if (field.type === "single_choice")
      return pillowChoice(field, entries[0]!, field.key === "crop_scope" ? pillowCropSubject : pillowPrintSide);
    if (field.key !== "crop_scope" || field.type !== "short_text") return null;
    const subject = pillowCropSubject(entries[0]!);
    if (subject) entries[0] = subject;
  }
  if (field.type === "short_text" || field.type === "long_text") {
    const value = entries.join(", ");
    if (field.required && !value.trim()) return null;
    const minimum = field.validation?.minLength ?? 0;
    const maximum = field.validation?.maxLength ?? (field.type === "short_text" ? 500 : 10_000);
    if (value.length < minimum || value.length > maximum) return null;
    if (field.validation?.pattern && !matchesPattern(value, field.validation.pattern)) return null;
    return { kind: "value", value };
  }
  if (field.type === "single_choice") {
    const options = field.options.filter((candidate) => entries.some((entry) => normalizeIdentity(entry) === normalizeIdentity(candidate.value) || normalizeIdentity(entry) === normalizeIdentity(candidate.label)));
    return entries.length === 1 && options.length === 1 ? { kind: "value", value: options[0]!.value } : null;
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
    if (entries.length !== 1 || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value) return null;
    if (field.minDate && value < field.minDate || field.maxDate && value > field.maxDate) return null;
    return { kind: "value", value };
  }
  if (field.type === "color") {
    if (entries.length !== 1) return null;
    const value = entries[0] ?? "";
    const color = field.palette.find((candidate) => candidate.toLowerCase() === value.toLowerCase());
    return color ? { kind: "value", value: color } : null;
  }
  return null;
}

export function customizationFieldVisible(field: CustomizationField, values: Record<string, string | string[]>): boolean {
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
