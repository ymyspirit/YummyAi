import { describe, expect, it } from "vitest";
import { authorize, type AuthorizedResource } from "@yummyai/authz/authorize";
import { Permission, type Permission as PermissionValue } from "@yummyai/authz/permissions";
import type { TenantContext } from "@yummyai/contracts";
import type { DevelopmentOptions } from "@yummyai/contracts/catalog/development";
import {
  catalogDraftScope,
  catalogSpecificationDraftKey,
  currentReadableBasis,
  developmentEditorAccess,
  obsoleteCatalogDraftPrefixes,
  writableDevelopmentOptions,
  type EditorSelection,
} from "./editor-access";

const selection = (patch: Partial<EditorSelection> = {}): EditorSelection => ({
  form: true,
  compose: false,
  editSpu: false,
  spuId: null,
  specVersion: null,
  artworkId: null,
  artworkVersionId: null,
  ...patch,
});
const options = (): DevelopmentOptions =>
  ({
    preferenceScope: "tenant:operator",
    contextAuthority: "authority-v1",
    spus: [
      { id: "own", ownerUserId: "operator", revision: "old-revision" },
      { id: "foreign", ownerUserId: "another", teamId: "shared" },
    ],
    specifications: [
      { id: "spec-own", versionId: "own-v1", version: 1, spuId: "own" },
      { id: "spec-foreign", versionId: "foreign-v1", version: 1, spuId: "foreign" },
    ],
    artworks: [
      { id: "art", versionId: "art-v1", version: 1, ownerUserId: "another", teamId: "shared" },
    ],
    creativeVersions: [{ id: "creative" }],
    researchItems: [{ id: "research" }],
    materialAssets: [{ id: "asset" }],
    accounts: [{ id: "account" }],
    processes: [],
    canvasPrintSpecs: [],
    stockItems: [],
  }) as unknown as DevelopmentOptions;
function access(overrides: Partial<TenantContext> = {}) {
  const context: TenantContext = {
    tenantId: "tenant",
    userId: "operator",
    permissions: Object.values(Permission),
    dataScope: "tenant",
    permissionScopes: Object.fromEntries(
      Object.values(Permission).map((permission) => [permission, "tenant"]),
    ),
    teamIds: ["shared"],
    ...overrides,
  };
  return (permission: PermissionValue, resource?: AuthorizedResource) => {
    try {
      authorize(context, permission, resource);
      return true;
    } catch {
      return false;
    }
  };
}
const selfWrite = () =>
  access({
    permissionScopes: {
      [Permission.ProductWrite]: "self",
      [Permission.DesignRead]: "tenant",
      [Permission.DesignReview]: "tenant",
    },
  });

describe("current catalog editor authority", () => {
  it("blocks shared SPU edits for legacy bindings while retaining explicit specification edits", () => {
    const value = options();
    value.spus[0] = { ...value.spus[0]!, legacyPlanAmbiguous: true };
    const shared = developmentEditorAccess("specification", selection({ spuId: "own", editSpu: true }), value, access());
    expect(shared.allowed).toBe(false);
    expect(shared.message).toContain("历史商品关系待核对");
    const child = developmentEditorAccess("specification", selection({ spuId: "own", specVersion: "own-v1" }), value, access());
    expect(child.allowed).toBe(true);
  });
  it("rejects a foreign direct edit despite tenant reads and unrelated tenant grants", () => {
    const data = options(),
      can = selfWrite();
    expect(
      developmentEditorAccess(
        "specification",
        selection({ spuId: "foreign", editSpu: true }),
        data,
        can,
      ).allowed,
    ).toBe(false);
    expect(
      developmentEditorAccess(
        "specification",
        selection({ spuId: "own", editSpu: true }),
        data,
        can,
      ).allowed,
    ).toBe(true);
    expect(
      writableDevelopmentOptions(data, can).specifications.map((spec) => spec.versionId),
    ).toEqual(["own-v1"]);
  });
  it("uses trusted team IDs for the actual parent", () => {
    const data = options(),
      request = selection({ spuId: "foreign" });
    const grants = { [Permission.ProductWrite]: "team" as const };
    expect(
      developmentEditorAccess("specification", request, data, access({ permissionScopes: grants }))
        .allowed,
    ).toBe(true);
    expect(
      developmentEditorAccess(
        "specification",
        request,
        data,
        access({ permissionScopes: grants, teamIds: [] }),
      ).allowed,
    ).toBe(false);
  });
  it("rejects a specification URL that belongs to another SPU", () => {
    expect(
      developmentEditorAccess(
        "specification",
        selection({ spuId: "own", specVersion: "foreign-v1" }),
        options(),
        access(),
      ).allowed,
    ).toBe(false);
  });
  it("does not turn a missing version into a create form", () => {
    expect(
      developmentEditorAccess(
        "specification",
        selection({ specVersion: "missing" }),
        options(),
        access(),
      ).allowed,
    ).toBe(false);
    expect(
      developmentEditorAccess("artwork", selection({ artworkId: "missing" }), options(), access())
        .allowed,
    ).toBe(false);
  });
  it("checks review scope separately from broad product write", () => {
    const can = access({
      permissionScopes: { [Permission.ProductWrite]: "tenant", [Permission.DesignReview]: "self" },
    });
    expect(
      developmentEditorAccess(
        "artwork",
        selection({ artworkId: "art", artworkVersionId: "art-v1" }),
        options(),
        can,
      ).allowed,
    ).toBe(false);
  });
  it("rejects mismatched and archived artwork versions", () => {
    const data = options();
    expect(
      developmentEditorAccess(
        "artwork",
        selection({ artworkId: "art", artworkVersionId: "different" }),
        data,
        access(),
      ).allowed,
    ).toBe(false);
    data.archivedArtworks = data.artworks.map((art) => ({ ...art, archived: true }));
    data.artworks = [];
    expect(
      developmentEditorAccess("artwork", selection({ artworkId: "art" }), data, access()).allowed,
    ).toBe(false);
  });
  it("allows a still readable pinned version after publication without rebasing it", () => {
    const before = options(),
      after = options();
    after.artworks[0] = { ...after.artworks[0]!, versionId: "art-v2", version: 2 };
    expect(
      developmentEditorAccess(
        "artwork",
        selection({ artworkId: "art", artworkVersionId: "art-v1" }),
        after,
        access(),
        before,
      ).allowed,
    ).toBe(true);
    expect(currentReadableBasis(before, after, access()).artworks[0]!.version).toBe(1);
  });
  it("removes a lost parent and its specifications while keeping the other editor basis", () => {
    const before = options(),
      after = options();
    after.spus = after.spus.filter((spu) => spu.id !== "foreign");
    after.specifications[0] = { ...after.specifications[0]!, versionId: "own-v2", version: 2 };
    const basis = currentReadableBasis(before, after, access());
    expect(basis.specifications.map((spec) => spec.versionId)).toEqual(["own-v1"]);
    expect(basis.spus[0]!.revision).toBe("old-revision");
  });
  it("refreshes source choices while pruning removed art roots", () => {
    const before = options(),
      after = options();
    after.creativeVersions = [];
    after.researchItems = [];
    after.materialAssets = [];
    after.accounts = [];
    after.artworks = [];
    const basis = currentReadableBasis(before, after, access());
    expect([
      basis.creativeVersions,
      basis.researchItems,
      basis.materialAssets,
      basis.accounts,
      basis.artworks,
    ]).toEqual([[], [], [], [], []]);
  });
  it("rotates editor identity when root ownership changes", () => {
    const before = options(),
      after = options(),
      request = selection({ spuId: "own", editSpu: true });
    after.spus[0] = { ...after.spus[0]!, teamId: "new-team" };
    expect(developmentEditorAccess("specification", request, before, access()).key).not.toBe(
      developmentEditorAccess("specification", request, after, access()).key,
    );
  });
  it("clears only affected root draft prefixes on removal or reassignment", () => {
    const before = options(),
      after = options();
    after.spus = after.spus.filter((spu) => spu.id !== "foreign");
    const prefixes = obsoleteCatalogDraftPrefixes(before, after);
    expect(prefixes).toContain(`${catalogDraftScope(before)}:specification:foreign-v1`);
    expect(prefixes.some((prefix) => prefix.endsWith(":own-v1") || prefix.endsWith(":own"))).toBe(
      false,
    );
  });
  it("isolates drafts by authority and invalidates old batch version bases", () => {
    const before = options(),
      after = options();
    after.specifications[0] = { ...after.specifications[0]!, versionId: "own-v2" };
    expect(catalogSpecificationDraftKey(before, "own")).not.toBe(
      catalogSpecificationDraftKey(after, "own"),
    );
    after.contextAuthority = "authority-v2";
    expect(catalogDraftScope(before)).not.toBe(catalogDraftScope(after));
    expect(obsoleteCatalogDraftPrefixes(before, after)).toEqual([catalogDraftScope(before)]);
  });
});
