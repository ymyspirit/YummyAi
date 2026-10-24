import {describe,it,expect} from "vitest";
import {normalizeOrderModelCost,sumOrderModelCosts,orderModelBudgetAmount} from "./model-costs.js";
describe("original order model fee amounts",()=>{
 it("retains reported zero and eight-place small fees independently of unknown",()=>{expect(normalizeOrderModelCost(0)).toEqual({state:"reported",amount:"0.00000000"});expect(normalizeOrderModelCost(1e-8)).toEqual({state:"reported",amount:"0.00000001"});expect(normalizeOrderModelCost(undefined)).toEqual({state:"unknown",amount:null});});
 it("does not silently round invalid, excessive or finer-precision reports into costs",()=>{for(const amount of [NaN,Infinity,-1,1_000_001,1e-9,0.123456789,"0.04",null])expect(normalizeOrderModelCost(amount)).toEqual({state:"invalid",amount:null});});
 it("sums legacy six-place amounts and native eight-place receipts without floating arithmetic",()=>{expect(sumOrderModelCosts(["0.100000","0.20000000","0.00000001"])).toBe("0.30000001");expect(sumOrderModelCosts([])).toBe("0.00000000");});
 it("rejects malformed ledger projections instead of treating them as zero",()=>{for(const amount of ["-1","NaN","1e-8","0.000000001"])expect(()=>sumOrderModelCosts([amount])).toThrow("ORDER_MODEL_COST_INVALID");});
 it("reserves positive estimates conservatively without adding floating-point noise",()=>{expect(orderModelBudgetAmount(1e-12)).toBe("0.000001");expect(orderModelBudgetAmount(0.07)).toBe("0.070000");expect(orderModelBudgetAmount(0.1+0.2)).toBe("0.300000");expect(orderModelBudgetAmount("0.04000001")).toBe("0.040001");});
});
