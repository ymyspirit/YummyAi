import { ConflictException } from "@nestjs/common";
import { OrderArtworkLayoutError, orderPillowPhotoPlan as sharedPlan } from "@yummyai/order-design";
export { isPhotoOnlyPillowArtwork } from "@yummyai/order-design";
export function orderPillowPhotoPlan(...args: Parameters<typeof sharedPlan>) {
  try { return sharedPlan(...args); } catch(error) { if(error instanceof OrderArtworkLayoutError) throw new ConflictException(error.message); throw error; }
}
