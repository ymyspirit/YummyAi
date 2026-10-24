import { Permission, type Permission as PermissionValue } from "@yummyai/authz/permissions";
import type { AuthorizedResource } from "@yummyai/authz/authorize";
import type { DevelopmentOptions } from "@yummyai/contracts/catalog/development";
export type DevelopmentMode = "artwork" | "specification" | "development";
type Can = (permission: PermissionValue, resource?: AuthorizedResource) => boolean;
export type EditorSelection = {
  form: boolean;
  compose: boolean;
  editSpu: boolean;
  spuId: string | null;
  specVersion: string | null;
  artworkId: string | null;
  artworkVersionId: string | null;
};
export function catalogDraftScope(options: DevelopmentOptions) {
  return `${options.preferenceScope}:catalog:${options.contextAuthority ?? "legacy"}`;
}
const resource = (value: { ownerUserId?: string; teamId?: string } | undefined) => ({
  ownerId: value?.ownerUserId,
  teamId: value?.teamId,
});
export function writableDevelopmentOptions(
  options: DevelopmentOptions,
  can: Can,
): DevelopmentOptions {
  const spus = options.spus.filter((spu) => can(Permission.ProductWrite, resource(spu))),
    ids = new Set(spus.map((spu) => spu.id));
  return {
    ...options,
    spus,
    specifications: options.specifications.filter((spec) => ids.has(spec.spuId)),
  };
}
export function developmentEditorAccess(
  mode: DevelopmentMode,
  selection: EditorSelection,
  options: DevelopmentOptions,
  can: Can,
  basis = options,
) {
  const requested = selection.form || selection.compose || selection.editSpu;
  const result = (
    kind: string,
    id: string,
    allowed: boolean,
    unavailable = false,
    owner?: { ownerUserId?: string; teamId?: string },
  ) => ({
    requested,
    kind,
    allowed: requested && allowed && !unavailable,
    message: unavailable
      ? "要编辑的资料当前不可用 请关闭后刷新列表"
      : !allowed
        ? "当前资料超出编辑范围 可继续查看已授权内容"
        : "",
    key: `${mode}:${kind}:${id}:${owner?.ownerUserId ?? ""}:${owner?.teamId ?? ""}`,
  });
  if (selection.compose || mode === "development") {
    const art = basis.artworks.find(
        (a) =>
          a.versionId === selection.artworkVersionId &&
          (!selection.artworkId || a.id === selection.artworkId),
      ),
      current = options.artworks.find((a) => a.id === art?.id);
    return result(
      "combination",
      selection.artworkVersionId ?? "new",
      can(Permission.ProductWrite) &&
        can(Permission.DesignRead, current ? resource(current) : undefined),
      Boolean(selection.artworkVersionId && (!art || !current)),
      current,
    );
  }
  if (mode === "artwork") {
    const art = [...basis.artworks, ...(basis.archivedArtworks ?? [])].find((a) =>
        selection.artworkId
          ? a.id === selection.artworkId
          : a.versionId === selection.artworkVersionId,
      ),
      current = [...options.artworks, ...(options.archivedArtworks ?? [])].find(
        (a) => a.id === art?.id,
      );
    const unavailable = Boolean(
      (selection.artworkId || selection.artworkVersionId) &&
      (!art ||
        !current ||
        current.archived ||
        (selection.artworkVersionId && art.versionId !== selection.artworkVersionId)),
    );
    return result(
      "artwork",
      art?.id ?? selection.artworkId ?? selection.artworkVersionId ?? "new",
      can(Permission.ProductWrite, current ? resource(current) : undefined) &&
        can(Permission.DesignReview, current ? resource(current) : undefined),
      unavailable,
      current,
    );
  }
  const spec = selection.specVersion
    ? basis.specifications.find((s) => s.versionId === selection.specVersion)
    : undefined;
  const spu = options.spus.find((s) => s.id === (spec?.spuId ?? selection.spuId));
  const unavailable = Boolean(
    (selection.specVersion && (!spec || (selection.spuId && selection.spuId !== spec.spuId))) ||
    (selection.editSpu && !spu) ||
    (selection.spuId && !spu),
  );
  const kind = selection.editSpu
    ? "spu"
    : selection.specVersion
      ? "specification"
      : selection.spuId
        ? "batch"
        : "new_spu";
  if (selection.editSpu && spu?.legacyPlanAmbiguous)
    return { ...result(kind, spu.id, false, false, spu), message: "历史商品关系待核对 共享企划暂时只读 可继续查看和维护原商品规格" };
  return result(
    kind,
    selection.specVersion ?? selection.spuId ?? "new",
    can(Permission.ProductWrite, spu ? resource(spu) : undefined),
    unavailable,
    spu,
  );
}
/** Preserve the original input versions while pruning resources no longer readable. */
export function currentReadableBasis(
  basis: DevelopmentOptions,
  current: DevelopmentOptions,
  can: Can,
): DevelopmentOptions {
  const spus = basis.spus.filter((old) =>
      current.spus.some(
        (next) => next.id === old.id && can(Permission.ProductWrite, resource(next)),
      ),
    ),
    spuIds = new Set(spus.map((s) => s.id));
  return {
    ...basis,
    contextAuthority: current.contextAuthority,
    spus,
    specifications: basis.specifications.filter(
      (old) => spuIds.has(old.spuId) && current.specifications.some((next) => next.id === old.id),
    ),
    artworks: basis.artworks.filter((old) => current.artworks.some((next) => next.id === old.id)),
    creativeVersions: current.creativeVersions,
    researchItems: current.researchItems,
    materialAssets: current.materialAssets,
    accounts: current.accounts,
    processes: current.processes,
    canvasPrintSpecs: current.canvasPrintSpecs,
    stockItems: current.stockItems,
  };
}
export function catalogSpecificationDraftKey(options: DevelopmentOptions, spuId: string) {
  const versions = options.specifications
    .filter((spec) => spec.spuId === spuId)
    .map((spec) => spec.versionId)
    .sort()
    .join(",");
  return `${catalogDraftScope(options)}:specification-batch:${spuId}:${versions || "empty"}`;
}
export function obsoleteCatalogDraftPrefixes(
  before: DevelopmentOptions,
  after: DevelopmentOptions,
) {
  const prefix = catalogDraftScope(before);
  if (before.contextAuthority !== after.contextAuthority) return [prefix];
  const changed = (
    a: { ownerUserId?: string; teamId?: string },
    b: { ownerUserId?: string; teamId?: string } | undefined,
  ) => !b || a.ownerUserId !== b.ownerUserId || a.teamId !== b.teamId;
  const lost = before.spus.filter((spu) =>
      changed(
        spu,
        after.spus.find((next) => next.id === spu.id),
      ),
    ),
    ids = new Set(lost.map((spu) => spu.id));
  const arts = [...after.artworks, ...(after.archivedArtworks ?? [])];
  return [
    ...lost.map((spu) => `${prefix}:specification-batch:${spu.id}`),
    ...before.specifications
      .filter((spec) => ids.has(spec.spuId))
      .map((spec) => `${prefix}:specification:${spec.versionId}`),
    ...[...before.artworks, ...(before.archivedArtworks ?? [])]
      .filter((art) =>
        changed(
          art,
          arts.find((next) => next.id === art.id),
        ),
      )
      .map((art) => `${prefix}:combination:${art.versionId}`),
  ];
}
