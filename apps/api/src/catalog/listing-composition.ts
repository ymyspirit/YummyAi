import type { SalesRecipeView } from "@yummyai/contracts/catalog/development";
import { SalesPlanFieldsSchema } from "@yummyai/contracts/catalog/sales-plan";
import {CustomSalesSkuMappingSchema} from "@yummyai/contracts/catalog/composition";
import type {ListingDraft} from "@yummyai/platform-rules";
export function listingOwnsRecipe(listing: {styleId?:string|null;spuId:string;salesPlanId?:string|null},content: {attributes:Record<string,unknown>},recipe: SalesRecipeView) {
  if(listing.spuId!==recipe.specification.spuId)return false;
  if(listing.styleId===recipe.styleId)return true;
  if(!listing.salesPlanId)return false;
  let raw=content.attributes.custom_pattern_choices;
  if(typeof raw==="string") {try{raw=JSON.parse(raw);}catch{return false;}}
  const pattern=SalesPlanFieldsSchema.shape.patternChoices.safeParse(raw);
  return pattern.success && !!pattern.data?.options.some(o=>o.skuId===recipe.skuId);
}
export function listingRecipeVariant(content:ListingDraft,recipe:SalesRecipeView){
  const own=content.variants.find(v=>v.skuId===recipe.skuId);if(own)return own;
  try{const raw=content.attributes.custom_sales_sku_mapping,parsed=CustomSalesSkuMappingSchema.parse(typeof raw==="string"?JSON.parse(raw):raw),mapping=parsed.find(m=>m.skuId===recipe.skuId&&m.specificationId===recipe.specification.id);return mapping?content.variants.find(v=>v.skuId===mapping.platformSkuId&&v.skuCode===mapping.platformSkuCode):undefined;}catch{return undefined;}
}
export function listingSalesSkuIds(content:ListingDraft){try{const raw=content.attributes.custom_sales_sku_mapping;return [...new Set([...content.variants.map(v=>v.skuId),...CustomSalesSkuMappingSchema.parse(typeof raw==="string"?JSON.parse(raw):raw).map(m=>m.skuId)])];}catch{return content.variants.map(v=>v.skuId);}}
