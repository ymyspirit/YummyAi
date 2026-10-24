/** The original public research-image boundary, shared by API freezing and the
 * Worker. It does not authenticate to marketplaces or follow redirects. */
export async function readAssistResearchImageBytes(raw:string,request:typeof globalThis.fetch=globalThis.fetch):Promise<Uint8Array>{
 const url=new URL(raw),hosts=new Set(["i.etsystatic.com","m.media-amazon.com","images-na.ssl-images-amazon.com","images-eu.ssl-images-amazon.com"]);
 if(url.protocol!=="https:"||url.username||url.password||url.port||!hosts.has(url.hostname))throw new Error("image_source_rejected");
 const response=await request(url,{redirect:"error",signal:AbortSignal.timeout(12000),headers:{accept:"image/jpeg,image/png,image/webp"}});
 if(!response.ok||!response.headers.get("content-type")?.startsWith("image/")||!response.body)throw new Error("image_unavailable");
 const reader=response.body.getReader(),chunks:Uint8Array[]=[];let size=0;
 try{
  while(true){const chunk=await reader.read();if(chunk.done)break;size+=chunk.value.length;
   if(size>4*1024*1024){await reader.cancel();throw new Error("image_too_large");}chunks.push(chunk.value);
  }
 }finally{reader.releaseLock();}
 return Buffer.concat(chunks);
}
