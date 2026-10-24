import { z } from "zod";

const Id = z.uuidv7().transform(value => value.toLowerCase());
const Hash = z.string().regex(/^[a-f0-9]{64}$/);
/** Non-private pointer to one explicitly selected retained source row. */
export const FactoryErpEvidenceSourceSchema = z.object({
  importId: Id, fileChecksum: Hash, previewChecksum: Hash, rowNumber: z.int().min(2).max(5001),
}).strict();
export type FactoryErpEvidenceSource = z.infer<typeof FactoryErpEvidenceSourceSchema>;
