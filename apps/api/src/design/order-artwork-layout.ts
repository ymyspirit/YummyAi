import { ConflictException } from "@nestjs/common";
import { OrderArtworkLayoutError, assertAutomaticArtwork as assertShared, composeOrderArtwork as composeShared } from "@yummyai/order-design";
export function assertAutomaticArtwork(...args: Parameters<typeof assertShared>) {
  try { return assertShared(...args); } catch(error) { if(error instanceof OrderArtworkLayoutError) throw new ConflictException(error.message); throw error; }
}
export async function composeOrderArtwork(...args: Parameters<typeof composeShared>) {
  try { return await composeShared(...args); } catch(error) { if(error instanceof OrderArtworkLayoutError) throw new ConflictException(error.message); throw error; }
}
