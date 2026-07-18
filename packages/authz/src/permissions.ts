export const Permission = {
  AssetPromote: "asset:promote",
  AssetRead: "asset:read",
  AssetWrite: "asset:write",
  CaptureRead: "capture:read",
  CaptureWrite: "capture:write",
  DashboardRead: "dashboard:read",
  DesignRead: "design:read",
  DesignReview: "design:review",
  DesignWrite: "design:write",
  ListingRead: "listing:read",
  ListingReview: "listing:review",
  ListingWrite: "listing:write",
  JobRead: "job:read",
  MembershipManage: "membership:manage",
  ModelConfigure: "model:configure",
  NotificationRead: "notification:read",
  ProductRead: "product:read",
  ProductWrite: "product:write",
  ResearchRead: "research:read",
  ResearchWrite: "research:write",
} as const;

export type Permission = (typeof Permission)[keyof typeof Permission];
