import {renderToStaticMarkup} from "react-dom/server";
import {describe,expect,it} from "vitest";
import {createEntityId} from "@yummyai/contracts";
import {Permission} from "@yummyai/authz/permissions";
import {AdGoalFieldsSchema,adCurrencyBasis,type AdGoalVersion} from "@yummyai/contracts/advertising";
import {ErpIdentityContext} from "../identity/erp-access";
import {AdGoalForm} from "./advertising-forms";
const scope={accountId:createEntityId(),marketplace:"US" as const,currency:"USD",asin:"B012345678"};
function goal(pinned:boolean):AdGoalVersion{return {id:createEntityId(),productId:createEntityId(),revision:1,scope,checksum:"a".repeat(64),createdAt:"2026-09-01T00:00:00.000Z",fields:AdGoalFieldsSchema.parse({mode:"profit_defense",effectiveFrom:"2026-09-01",unitPriceMinor:10000,unitCostMinor:7000,targetAcosBps:2000,coreKeywords:[],protectedTerms:[],trialEndDate:null,trialSpendLimitMinor:null,...(pinned?{monetaryBasis:adCurrencyBasis("USD")}:{} )})};}
function render(value:AdGoalVersion|null){return renderToStaticMarkup(<ErpIdentityContext.Provider value={{session:{authenticated:true,canUseErp:true,tenantId:createEntityId(),userId:createEntityId(),displayName:"Synthetic operator",organizationName:"Synthetic organization",permissions:[Permission.CustomerIntelligenceReview],dataScope:"tenant"},localDevelopment:false,logout(){}}}><AdGoalForm scope={scope} goal={value} expectedRevision={value?.revision??0} permitted onSaved={async()=>{}} onDirty={()=>{}} /></ErpIdentityContext.Provider>);}
describe("legacy advertising money needs visible manual confirmation",()=>{
 it("keeps the required legacy spend input visible and blank without reinterpreting the old integer",()=>{const html=render(goal(false));expect(html).toMatch(/<details[^>]*\bopen=""[^>]*><summary>样本门槛与调整限制<\/summary>/);const input=/<input\b[^>]*name="minimumSpend"[^>]*>/.exec(html)?.[0];expect(input).toBeDefined();expect(input).toContain('required=""');expect(input).not.toMatch(/\bvalue="[^"]+"/);expect(html).toContain("USD 1000 保存的最小单位");});
 it("keeps a pinned or genuinely new goal compact and uses its explicit new-entry precision",()=>{for(const value of[goal(true),null]){const html=render(value),match=/<details([^>]*)><summary>样本门槛与调整限制<\/summary>/.exec(html);expect(match).not.toBeNull();expect(match![1]).not.toContain("open");expect(html).toMatch(/<input[^>]*name="minimumSpend"[^>]*value="10\.00"/);}});
});
