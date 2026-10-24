"use client";
import type { PrintBinding } from "@yummyai/contracts/catalog/composition";
import type { ArtworkView } from "@yummyai/contracts/catalog/development";
export function PrintBindingsEditor({ bindings, artworks, onChange }: { bindings: PrintBinding[]; artworks: ArtworkView[]; onChange: (next: PrintBinding[])=>void }) {
  const update=(i:number,patch:Partial<PrintBinding>)=>onChange(bindings.map((b,n)=>n===i?{...b,...patch}:b));
  return <div className="pd-span"><p>按图层顺序叠加固定装饰与顾客定制区域。制作面和区域会固定在新配方中。</p>
    {bindings.map((binding,i)=>{const art=artworks.find(a=>a.versionId===binding.artworkVersionId);return <fieldset className="pd-form" key={i}><legend>印花绑定 {i+1}</legend>
      <label>绑定编号<input required pattern="[a-z][a-z0-9_]*" maxLength={60} value={binding.key} onChange={e=>update(i,{key:e.target.value})}/></label>
      <label>印花版本<select required value={binding.artworkVersionId} onChange={e=>update(i,{artworkVersionId:e.target.value,fieldMappings:[]})}><option value="">请选择</option>{artworks.map(a=><option key={a.versionId} value={a.versionId}>{a.code} · {a.name} · v{a.version}</option>)}</select></label>
      <label>制作面<select value={binding.surface} onChange={e=>update(i,{surface:e.target.value as PrintBinding["surface"]})}><option value="front">正面</option><option value="back">反面（需双面工艺）</option></select></label>
      <label>制作区域编号<input required pattern="[a-z][a-z0-9_]*" maxLength={80} value={binding.region} onChange={e=>update(i,{region:e.target.value})}/></label>
      {(["xPercent","yPercent","widthPercent","heightPercent"] as const).map((key,n)=><label key={key}>{["左侧 %","顶部 %","区域宽 %","区域高 %"][n]}<input required type="number" min={n<2?0:0.01} max={100} step="any" value={binding.area[key]} onChange={e=>update(i,{area:{...binding.area,[key]:Number(e.target.value)}})}/></label>)}
      {art?.customization.fields.map(field=><label key={field.key}>顾客字段 → {field.label}（{field.key}）<input required pattern="[a-z][a-z0-9_]*" maxLength={80} value={binding.fieldMappings.find(m=>m.fieldKey===field.key)?.customerFieldKey??field.key} onChange={e=>update(i,{fieldMappings:[...binding.fieldMappings.filter(m=>m.fieldKey!==field.key),{fieldKey:field.key,customerFieldKey:e.target.value}]})}/><small>{binding.surface==="front"?"正面":"反面"} / {binding.region}；不同区域使用独立顾客字段。</small></label>)}
      <button className="oc-button" type="button" disabled={bindings.length===1} onClick={()=>onChange(bindings.filter((_,n)=>n!==i))}>移除此绑定</button></fieldset>;})}
    <button className="oc-button" type="button" disabled={bindings.length>=30} onClick={()=>onChange([...bindings,{key:`print_${bindings.length+1}`,artworkVersionId:"",surface:"front",region:"whole",area:{xPercent:0,yPercent:0,widthPercent:100,heightPercent:100},fieldMappings:[]}])}>添加印花或装饰</button></div>;
}
