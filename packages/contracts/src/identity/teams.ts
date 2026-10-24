import { z } from "zod";
import { EntityIdSchema } from "@yummyai/contracts/common/ids";

const command = { requestId: z.uuid(), reason: z.string().trim().min(5).max(500) };
export const CreateTeamSchema = z
  .object({ ...command, name: z.string().trim().min(1).max(120) })
  .strict();
export const UpdateTeamSchema = z
  .object({
    ...command,
    expectedRevision: z.int().positive(),
    name: z.string().trim().min(1).max(120),
    status: z.enum(["active", "archived"]),
  })
  .strict();
export const SetTeamMemberSchema = z
  .object({
    ...command,
    membershipId: EntityIdSchema,
    active: z.boolean(),
    expectedRevision: z.int().positive().nullable(),
  })
  .strict();
export const TeamCommandResultSchema = z.object({
  id: EntityIdSchema,
  revision: z.int().positive(),
  replayed: z.boolean(),
});
export const TeamQuerySchema = z
  .object({
    q: z.string().trim().max(120).default(""),
    memberQ: z.string().trim().max(120).default(""),
    page: z.coerce.number().int().positive().default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict();
export const TeamWorkspaceSchema = z.object({
  page: z.int().positive(),
  pageSize: z.int().positive(),
  total: z.int().nonnegative(),
  membersTruncated: z.boolean(),
  teams: z.array(
    z.object({
      id: EntityIdSchema,
      name: z.string(),
      status: z.enum(["active", "archived"]),
      revision: z.int().positive(),
      members: z.array(
        z.object({
          membershipId: EntityIdSchema,
          displayName: z.string(),
          active: z.boolean(),
          revision: z.int().positive(),
        }),
      ),
    }),
  ),
  members: z.array(z.object({ id: EntityIdSchema, displayName: z.string() })),
});
export type TeamWorkspace = z.infer<typeof TeamWorkspaceSchema>;
export const TeamOptionsSchema = z.array(z.object({ id: EntityIdSchema, name: z.string() }));
