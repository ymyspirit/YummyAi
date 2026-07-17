import { SetMetadata } from "@nestjs/common";
import type { PermissionValue } from "@yummyai/authz";

export const REQUIRED_PERMISSIONS = "yummyai:required-permissions";

export const RequiresPermission = (...permissions: PermissionValue[]) =>
  SetMetadata(REQUIRED_PERMISSIONS, permissions);
