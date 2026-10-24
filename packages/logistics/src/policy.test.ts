import { describe,expect,it } from "vitest";
import { decimalMinor,selectLogisticsQuote } from "./policy.js";
import type { LogisticsQuote,LogisticsRule } from "@yummyai/contracts/logistics";
const now=new Date("2026-10-12T00:00:00Z"),task={readyAt:"2026-10-13T00:00:00Z",latestShipAt:"2026-10-14T00:00:00Z",deliverBy:"2026-10-20T00:00:00Z"};
const rule:LogisticsRule={name:"Synthetic cap",autoPurchase:true,currency:"USD",maxTicketMinor:1000,maxDailyMinor:2000,quoteMaxAgeSeconds:120,allowedChannelCodes:["cheap","fast"],evidence:"Synthetic budget approval"};
const quote=(patch:Partial<LogisticsQuote>={}):LogisticsQuote=>({channelCode:"cheap",channelName:"Synthetic service",totalMinor:500,currency:"USD",currencySource:"Fixture account billing verified",transitDaysMin:3,transitDaysMax:5,transitSource:"Confirmed calendar-day maximum",conditionsVerified:true,priceSource:"Synthetic price",quotedAt:now.toISOString(),diagnostic:null,...patch});
describe("deadline and cost constrained logistics selection",()=>{
  it("chooses cheapest only after satisfying the latest dispatch and delivery bound",()=>{const result=selectLogisticsQuote([quote({transitDaysMax:8}),quote({channelCode:"fast",totalMinor:800,transitDaysMax:4})],rule,task,now);expect(result.selected?.channelCode).toBe("fast");expect(result.rejected).toContainEqual({channelCode:"cheap",reason:"DELIVERY_DEADLINE_MISSED"});});
  it("requires currency, SLA, conditions, a fresh price and the per-ticket cap",()=>{for(const patch of [{currency:null},{transitDaysMax:null},{conditionsVerified:false},{totalMinor:1001},{quotedAt:"2026-10-11T00:00:00Z"}] as Partial<LogisticsQuote>[])expect(selectLogisticsQuote([quote(patch)],rule,task,now).selected).toBeNull();});
  it("rejects a missed shipping deadline even with a fast quote",()=>expect(selectLogisticsQuote([quote({transitDaysMax:1})],rule,task,new Date("2026-10-15T00:00:00Z")).selected).toBeNull());
  it("keeps exact currency minor units without silent rounding",()=>{expect(decimalMinor("1.20",2)).toBe(120);expect(decimalMinor("120",0)).toBe(120);expect(decimalMinor("1.234",3)).toBe(1234);expect(()=>decimalMinor("1.234",2)).toThrow();expect(()=>decimalMinor("9e9",2)).toThrow();expect(()=>decimalMinor("9007199254740992",0)).toThrow();});
});
