import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { createEntityId, type PodArtworkTaskView } from "@yummyai/contracts";
import type { AgentMethodRow, AgentMethodWorkspace } from "@yummyai/contracts/harness/methods";
import type { WorkflowRunDetail } from "@yummyai/contracts/workflow";
import { Permission } from "../../../packages/authz/src/index";
import { workflowApi, workflowOperatorFixture } from "./workflow-operator-fixture";

const profile = "yummyai.custom_product.generate_provisional_facts", workflowKey = `workflow.${profile}`, podKey = "pod.artwork.pattern_crop";
async function method(key: string) { return (await workflowApi<AgentMethodWorkspace>("agent-methods/workspace")).methods.find(row=>row.methodKey===key); }
async function publish(key: string, notes: string) {
  const current=await method(key);
  await workflowApi("agent-methods/save",{methodKey:key,expectedRevision:current?.revision??0,notes,knowledgeVersionIds:[],reason:"Synthetic browser method review",requestId:randomUUID()});
  for(const action of ["submit","publish"] as const){const row=(await method(key))!;await workflowApi(`agent-methods/${row.id}/${action}`,{expectedRevision:row.revision,version:row.latestVersion,reason:"Synthetic reviewed publication",requestId:randomUUID(),...(action==="publish"?{reviewedChecksum:row.latest.checksum}:{})});}
  return (await method(key)) as AgentMethodRow;
}

test("workflow and POD records open their original published history after a new publication",async({page},testInfo)=>{
  const fixture=await workflowOperatorFixture(),errors:string[]=[];
  page.on("pageerror",error=>errors.push(error.message));
  try {
    const firstWorkflow=await publish(workflowKey,"Synthetic workflow original reviewed notes"),firstPod=await publish(podKey,"Synthetic POD original reviewed notes");
    const source=await fixture.source(),run=await fixture.run(profile,{researchSnapshotId:source.snapshotId},undefined,false);
    const product=await fixture.podProduct();
    const task=await workflowApi<PodArtworkTaskView>("pod/tasks",{idempotencyKey:createEntityId(),skuId:product.skuId,toolKey:"pattern_crop",title:"Synthetic original method crop",inputAssetIds:[product.assetId],parameterSnapshot:{mode:"general",multiCrop:false,maximumCropsPerInput:1,outputFormat:"png",background:"preserved",perspectiveCorrection:true,cropPaddingPercent:2}});
    await publish(workflowKey,"Synthetic workflow newer reviewed notes");await publish(podKey,"Synthetic POD newer reviewed notes");
    await fixture.startWorker();
    await expect.poll(async()=>(await workflowApi<WorkflowRunDetail>(`workflow-runs/${run.id}`)).currentNodeId,{timeout:20000}).toBe("review");
    await page.setViewportSize({width:1440,height:1000});await page.goto(`/workflows/runs/${run.id}?node=execute`);
    const workflowEvidence=page.locator(".wf-attempt-history > li").first().getByRole("region",{name:"本次固定的方法",exact:true});
    await expect(workflowEvidence).toContainText(`团队方法 v${firstWorkflow.activeVersion}`);
    const opened=page.waitForEvent("popup");await workflowEvidence.getByRole("link",{name:"查看此版本"}).click();const history=await opened;
    await expect(history.getByRole("region",{name:"方法版本记录"})).toContainText("Synthetic workflow original reviewed notes");await expect(history).toHaveURL(new RegExp(`version=${firstWorkflow.activeVersion}`));await history.close();
    await page.screenshot({path:testInfo.outputPath("workflow-method-desktop.png"),fullPage:true,animations:"disabled"});
    await page.setViewportSize({width:390,height:900});await workflowEvidence.scrollIntoViewIfNeeded();
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=document.documentElement.clientWidth)).toBe(true);
    await workflowEvidence.getByText(`团队方法 v${firstWorkflow.activeVersion}`,{exact:true}).click();
    await page.screenshot({path:testInfo.outputPath("workflow-method-mobile.png"),fullPage:false,animations:"disabled"});
    await page.setViewportSize({width:1440,height:1000});await page.goto(`/pod-workbench?module=print_extraction&task=${task.id}#pod-task-${task.id}`);
    const podEvidence=page.locator(`#pod-task-${task.id}`).getByRole("region",{name:"本次固定的方法",exact:true});
    await expect(podEvidence).toContainText(`团队方法 v${firstPod.activeVersion}`);
    const podOpened=page.waitForEvent("popup");await podEvidence.getByRole("link",{name:"查看此版本"}).click();const podHistory=await podOpened;
    await expect(podHistory.getByRole("region",{name:"方法版本记录"})).toContainText("Synthetic POD original reviewed notes");await podHistory.close();
    await page.screenshot({path:testInfo.outputPath("pod-method-desktop.png"),fullPage:true,animations:"disabled"});
    await page.setViewportSize({width:390,height:900});await podEvidence.scrollIntoViewIfNeeded();
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=document.documentElement.clientWidth)).toBe(true);
    await podEvidence.getByText(`团队方法 v${firstPod.activeVersion}`,{exact:true}).click();
    await page.screenshot({path:testInfo.outputPath("pod-method-mobile.png"),fullPage:false,animations:"disabled"});
    const selected=await workflowApi<PodArtworkTaskView>(`pod/tasks/${task.id}`);expect(selected.methodSnapshot).toEqual(task.methodSnapshot);expect(selected.status).toBe("queued");
    expect(fixture.proof().syntheticPodCalls).toBe(0);
    await fixture.permissions(Object.values(Permission).filter(p=>p!==Permission.WorkflowRead));await page.reload();
    await expect(page.locator(`#pod-task-${task.id}`)).toHaveCount(0);await expect(page.getByRole("region",{name:"本次固定的方法",exact:true})).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally {await fixture.close();}
});

test("POD completion downloads the original files receipt and rechecks current rights at desktop and mobile widths", async ({page},testInfo) => {
  const fixture=await workflowOperatorFixture(),errors:string[]=[];
  page.on("pageerror",error=>errors.push(error.message));
  try {
    await publish(podKey,"Synthetic stable completion publication");
    const product=await fixture.podProduct();
    const task=await workflowApi<PodArtworkTaskView>("pod/tasks",{idempotencyKey:createEntityId(),skuId:product.skuId,toolKey:"pattern_crop",title:"Synthetic audited output receipt",inputAssetIds:[product.assetId],parameterSnapshot:{mode:"general",multiCrop:false,maximumCropsPerInput:1,outputFormat:"png",background:"preserved",perspectiveCorrection:true,cropPaddingPercent:2}});
    expect(await fixture.completePod(task.id)).toMatchObject({disposition:"awaiting_review"});
    const original=(await workflowApi<PodArtworkTaskView>(`pod/tasks/${task.id}`)).completion!;
    expect(original.evidence).toMatchObject({requiresBusinessReview:true,automaticProductionApproval:false,resultState:"awaiting_review"});
    await page.setViewportSize({width:1440,height:1000});await page.goto(`/pod-workbench?module=pattern_processing&task=${task.id}#pod-task-${task.id}`);
    const evidence=page.locator(`#pod-task-${task.id}`).getByRole("region",{name:"原始产物交接",exact:true});
    await expect(evidence).toContainText("1 个文件");
    const downloading=page.waitForEvent("download");await evidence.getByRole("button",{name:"下载交接记录"}).click();const downloaded=await downloading;
    expect(downloaded.suggestedFilename()).toBe(`pod-completion-${task.id}.json`);
    expect(JSON.parse(await readFile((await downloaded.path())!,"utf8"))).toEqual(original);
    await page.screenshot({path:testInfo.outputPath("pod-completion-desktop.png"),fullPage:true,animations:"disabled"});
    await page.setViewportSize({width:390,height:900});await evidence.scrollIntoViewIfNeeded();
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=document.documentElement.clientWidth)).toBe(true);
    await evidence.getByText("已记录原始产物交接",{exact:true}).click();
    await page.screenshot({path:testInfo.outputPath("pod-completion-mobile.png"),fullPage:false,animations:"disabled"});
    const path=`**/api/pod/tasks/${task.id}/completion`;
    await page.route(path,route=>route.fulfill({status:503,contentType:"application/json",body:"{}"}));
    await evidence.getByRole("button",{name:"下载交接记录"}).click();await expect(evidence.getByRole("alert")).toContainText("稍后重试");await page.unroute(path);
    await fixture.permissions(Object.values(Permission).filter(value=>value!==Permission.AssetRead));
    await evidence.getByRole("button",{name:"下载交接记录"}).click();
    await expect(evidence).toContainText("交接记录已不可读取");await expect(evidence.getByRole("button")).toHaveCount(0);
    expect(fixture.proof().syntheticPodCalls).toBe(1);expect(errors).toEqual([]);
  } finally {await fixture.close();}
});
