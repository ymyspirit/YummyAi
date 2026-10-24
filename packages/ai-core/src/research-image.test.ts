import { describe, expect, it, vi } from "vitest";
import { readAssistResearchImageBytes } from "./research-image.js";
describe("fixed public research image source",()=>{
 it("rejects private or credentialed origins before requesting bytes",async()=>{
  const request=vi.fn<typeof fetch>();
  for(const url of ["http://m.media-amazon.com/x","https://127.0.0.1/x","https://m.media-amazon.com.evil.invalid/x","https://u:p@m.media-amazon.com/x","https://m.media-amazon.com:444/x"])
   await expect(readAssistResearchImageBytes(url,request)).rejects.toThrow("image_source_rejected");
  expect(request).not.toHaveBeenCalled();
 });
 it("reads exact bounded source bytes with the original redirect and timeout controls",async()=>{
  const expected=new Uint8Array([1,2,3,4]),request=vi.fn<typeof fetch>(async()=>new Response(expected,{headers:{"content-type":"image/png"}}));
  expect([...await readAssistResearchImageBytes("https://m.media-amazon.com/test.png",request)]).toEqual([...expected]);
  expect(request).toHaveBeenCalledOnce();const [url,options]=request.mock.calls[0]!;
  expect(String(url)).toBe("https://m.media-amazon.com/test.png");expect(options).toMatchObject({redirect:"error",headers:{accept:"image/jpeg,image/png,image/webp"}});
  expect(options?.signal).toBeInstanceOf(AbortSignal);expect(options?.signal?.aborted).toBe(false);
 });
 it("does not accept unavailable responses or nonimage bodies as frozen media",async()=>{
  for(const response of [new Response("x",{status:404,headers:{"content-type":"image/png"}}),new Response("<html>",{headers:{"content-type":"text/html"}}),new Response(null,{headers:{"content-type":"image/png"}})])
   await expect(readAssistResearchImageBytes("https://i.etsystatic.com/x",vi.fn<typeof fetch>(async()=>response))).rejects.toThrow("image_unavailable");
 });
 it("cancels a stream above four MiB rather than pinning a partial image",async()=>{
  let cancelled=false;
  const body=new ReadableStream<Uint8Array>({start(controller){controller.enqueue(new Uint8Array(4*1024*1024));controller.enqueue(new Uint8Array(1));},cancel(){cancelled=true;}});
  const request=vi.fn<typeof fetch>(async()=>new Response(body,{headers:{"content-type":"image/webp"}}));
  await expect(readAssistResearchImageBytes("https://images-eu.ssl-images-amazon.com/x",request)).rejects.toThrow("image_too_large");expect(cancelled).toBe(true);
 });
});
