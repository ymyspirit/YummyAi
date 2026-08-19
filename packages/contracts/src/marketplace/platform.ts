import { z } from "zod";

export const MarketplacePlatformSchema = z.enum(["amazon", "etsy"]);

export type MarketplacePlatform = z.infer<typeof MarketplacePlatformSchema>;
