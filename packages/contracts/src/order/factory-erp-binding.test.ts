import { describe, expect, it } from "vitest";
import { ChangeFactoryErpBindingSchema, FactoryErpBindingChangeResultSchema, FactoryErpBindingViewSchema, FactoryErpBindingPageSchema } from "./factory-erp-binding.js";
import { FactoryErpAssociationPinSchema } from "./factory-erp-association.js";
import { ApplyFactoryErpImportSchema } from "./factory-erp-import.js";
import { canonicalJson } from "../common/canonical-json.js";
const id = (value: number) => `01a15d70-0000-7000-8000-${String(value).padStart(12, "0")}`;
const hash = "a".repeat(64), source = { importId: id(2), fileChecksum: hash, previewChecksum: hash, rowNumber: 2 };
const selection = { deliveryItemId: id(3), productionOrderId: id(4), productionVersionId: id(5), fileChecksum: hash, manufacturingChecksum: hash };
const release = () => ({ action: "release", expectedRevision: 1, expectedItemsChecksum: hash, expectedObservationSequence: 9, source,
  reasonCode: "wrong_group", idempotencyKey: id(6), confirmed: true });
const result = () => ({ id: id(6), bindingId: id(1), factoryId: id(7), action: "release", reasonCode: "wrong_group", source,
  originalRevision: 1, originalItemsChecksum: hash, originalObservationSequence: 9, replacementBindingId: null, replacementRevision: null,
  application: null, requestChecksum: hash, createdAt: "2026-10-21T00:00:00.000Z" });

describe("factory binding explicit revision and correction boundary", () => {
  it("normalizes new UUID identities before canonical comparison and duplicate detection", () => {
    const parsed = ChangeFactoryErpBindingSchema.parse({ ...release(), action: "correct", source: { ...source, importId: source.importId.toUpperCase() },
      idempotencyKey: id(6).toUpperCase(), items: [{ ...selection, deliveryItemId: selection.deliveryItemId.toUpperCase() }], wholeGroupConfirmed: true });
    expect(parsed.source.importId).toBe(source.importId); expect(parsed.idempotencyKey).toBe(id(6));
    expect(parsed.action === "correct" && parsed.items[0]?.deliveryItemId).toBe(selection.deliveryItemId);
    expect(ChangeFactoryErpBindingSchema.safeParse({ ...release(), action: "correct", items: [selection, { ...selection, deliveryItemId: selection.deliveryItemId.toUpperCase(), productionOrderId: id(9) }], wholeGroupConfirmed: true }).success).toBe(false);
    expect(FactoryErpAssociationPinSchema.parse({ expectedActiveBindingId: id(1).toUpperCase(), expectedRevision: 1, expectedReleaseId: null, confirmed: true }).expectedActiveBindingId).toBe(id(1));
  });
  it("keeps permanent intent limited to IDs, hashes and structured reasons", () => {
    expect(ChangeFactoryErpBindingSchema.safeParse(release()).success).toBe(true);
    for (const value of [{ ...release(), note: "private customer information" }, { ...release(), externalId: "private" },
      { ...release(), source: { ...source, rawCells: ["private"] } }, { ...release(), reasonCode: "unreviewed_free_text" }])
      expect(ChangeFactoryErpBindingSchema.safeParse(value).success).toBe(false);
  });
  it("requires explicit confirmation and prevents a release from smuggling a new group", () => {
    for (const value of [{ ...release(), confirmed: false }, { ...release(), items: [selection] },
      { ...release(), action: "correct", items: [selection] }, { ...release(), action: "correct", items: [], wholeGroupConfirmed: true }])
      expect(ChangeFactoryErpBindingSchema.safeParse(value).success).toBe(false);
    expect(ChangeFactoryErpBindingSchema.safeParse({ ...release(), action: "correct", items: [selection], wholeGroupConfirmed: true }).success).toBe(true);
  });
  it("rejects repeated old delivery or production identities in a replacement group", () => {
    for (const repeated of [{ ...selection, productionOrderId: id(8) }, { ...selection, deliveryItemId: id(8) }])
      expect(ChangeFactoryErpBindingSchema.safeParse({ ...release(), action: "correct", items: [selection, repeated], wholeGroupConfirmed: true }).success).toBe(false);
  });
  it("distinguishes no binding, an active revision and the precise released revision", () => {
    for (const value of [{ expectedActiveBindingId: null, expectedRevision: 0, expectedReleaseId: null, confirmed: true },
      { expectedActiveBindingId: id(1), expectedRevision: 1, expectedReleaseId: null, confirmed: true },
      { expectedActiveBindingId: null, expectedRevision: 1, expectedReleaseId: id(6), confirmed: true }])
      expect(FactoryErpAssociationPinSchema.safeParse(value).success).toBe(true);
    for (const value of [{ expectedActiveBindingId: id(1), expectedRevision: 0, expectedReleaseId: null, confirmed: true },
      { expectedActiveBindingId: null, expectedRevision: 1, expectedReleaseId: null, confirmed: true }])
      expect(FactoryErpAssociationPinSchema.safeParse(value).success).toBe(false);
  });
  it("keeps legacy successful apply bodies canonical and validates explicit fresh pins", () => {
    const body = { fileChecksum: hash, previewChecksum: hash, idempotencyKey: id(9), confirmed: true,
      rows: [{ rowNumber: 2, items: [selection], wholeGroupConfirmed: true }] };
    expect(canonicalJson(ApplyFactoryErpImportSchema.parse(body))).toBe(canonicalJson(body));
    expect(ApplyFactoryErpImportSchema.safeParse({ ...body, rows: [{ ...body.rows[0], association: { expectedActiveBindingId: null, expectedRevision: 1, expectedReleaseId: id(6), confirmed: true } }] }).success).toBe(true);
  });
  it("does not allow a release receipt to claim an application or replacement", () => {
    expect(FactoryErpBindingChangeResultSchema.safeParse(result()).success).toBe(true);
    expect(FactoryErpBindingChangeResultSchema.safeParse({ ...result(), replacementBindingId: id(8) }).success).toBe(false);
  });
  it("requires correction receipts to identify the one new-source application and next revision", () => {
    const application = { id: id(10), importId: source.importId, fileChecksum: hash, previewChecksum: hash, requestChecksum: hash,
      createdAt: "2026-10-21T00:00:00.000Z", appliedRows: 1, observations: [{ rowNumber: 2, bindingId: id(8), observationId: id(11), disposition: "advanced", status: "scheduled" }] };
    const value = { ...result(), action: "correct", replacementBindingId: id(8), replacementRevision: 2, application };
    expect(FactoryErpBindingChangeResultSchema.safeParse(value).success).toBe(true);
    expect(FactoryErpBindingChangeResultSchema.safeParse({ ...value, replacementRevision: 3 }).success).toBe(false);
    expect(FactoryErpBindingChangeResultSchema.safeParse({ ...value, application: { ...application, importId: id(12) } }).success).toBe(false);
  });
  it("retains the complete old group and its release evidence in detail and paged history", () => {
    const value = { id: id(1), factoryId: id(7), revision: 1, previousBindingId: null, nextBindingId: null,
      releasedBy: id(6), state: "released", itemsChecksum: hash, quantity: 2, sourceImportId: id(2), observationSequence: 9,
      recordedStatus: "shipped", recordedException: null, items: [{ ...selection, quantity: 2 }], createdAt: "2026-10-21T00:00:00.000Z", release: result() };
    const parsed = FactoryErpBindingViewSchema.parse(value);
    expect(FactoryErpBindingViewSchema.safeParse({ ...value, release: null }).success).toBe(false);
    expect(FactoryErpBindingViewSchema.safeParse({ ...value, quantity: 3 }).success).toBe(false);
    const header = Object.fromEntries(Object.entries(parsed).filter(([key]) => key !== "items" && key !== "release"));
    expect(FactoryErpBindingPageSchema.safeParse({ items: [header], nextCursor: null }).success).toBe(true);
    expect(FactoryErpBindingPageSchema.safeParse({ items: [{ ...header, state: "active" }], nextCursor: null }).success).toBe(false);
    expect(FactoryErpBindingPageSchema.safeParse({ items: [{ ...header, revision: 2, previousBindingId: null }], nextCursor: null }).success).toBe(false);
  });
});
