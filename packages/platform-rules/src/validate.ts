import type { ListingDraft, ListingValidation, PlatformRules, ValidationIssue } from "./types.js";

export function validateListing(rules: PlatformRules, draft: ListingDraft): ListingValidation {
  if (draft.platform !== rules.platform) throw new Error(`Rules for ${rules.platform} cannot validate ${draft.platform}`);
  const blockers: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];
  for (const path of rules.requiredPaths) {
    if (isEmpty(readPath(draft, path))) blockers.push(issue(rules, "blocker", "common.required", path, `${path} is required`));
  }
  if (draft.title.length > rules.limits.title) blockers.push(issue(rules, "blocker", "common.title.length", "title", `Title exceeds ${rules.limits.title} characters`));
  if (draft.description.length > rules.limits.description) blockers.push(issue(rules, "blocker", "common.description.length", "description", `Description exceeds ${rules.limits.description} characters`));
  for (const candidate of rules.validate(draft)) {
    const complete = { ...candidate, ruleVersion: rules.version };
    (complete.severity === "blocker" ? blockers : warnings).push(complete);
  }
  const completed = rules.requiredPaths.filter((path) => !isEmpty(readPath(draft, path))).length;
  return { completeness: Math.round((completed / rules.requiredPaths.length) * 100), blockers, warnings };
}

function readPath(input: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((value, key) => value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined, input);
}

function isEmpty(value: unknown): boolean {
  return value === undefined || value === null || value === "" || (Array.isArray(value) && value.length === 0);
}

function issue(rules: PlatformRules, severity: ValidationIssue["severity"], code: string, path: string, message: string): ValidationIssue {
  return { severity, code, path, message, ruleVersion: rules.version };
}
