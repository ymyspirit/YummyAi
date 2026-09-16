import { useState } from "react";
import { App, Button, Empty, Input } from "antd";
import { Plus, Save, Trash2 } from "lucide-react";
import { useAssetStore, type TextAsset } from "@/stores/use-asset-store";
export function PromptsPage() {
  const { message, modal } = App.useApp();
  const { assets, hydrated, addAsset, updateAsset, removeAsset } = useAssetStore();
  const [query, setQuery] = useState(""), [id, setId] = useState<string>(), [title, setTitle] = useState(""), [content, setContent] = useState(""), [tags, setTags] = useState("");
  const prompts = assets.filter((asset): asset is TextAsset => asset.kind === "text");
  const edit = (asset?: TextAsset) => { setId(asset?.id); setTitle(asset?.title ?? ""); setContent(asset?.data.content ?? ""); setTags(asset?.tags.join("，") ?? ""); };
  const save = () => {
    const value = { title: title.trim(), data: { content: content.trim() }, tags: tags.split(/[,，]/).map(t => t.trim()).filter(Boolean) };
    if (id) updateAsset(id, value); else setId(addAsset({ ...value, kind: "text", coverUrl: "", source: "ERP 提示词库" }));
    message.info("已更新，保存状态见上方");
  };
  return <main className="prompt-page"><header className="prompt-toolbar"><h1>提示词库</h1><Button icon={<Plus size={14} />} onClick={() => edit()}>新建提示词</Button></header>
    <div className="prompt-layout"><section className="prompt-list"><Input aria-label="搜索提示词" placeholder="搜索名称、内容或标签" value={query} onChange={e => setQuery(e.target.value)} />
      {!hydrated ? <p>正在读取提示词…</p> : prompts.filter(p => `${p.title} ${p.data.content} ${p.tags.join(" ")}`.includes(query)).map(p => <button key={p.id} type="button" aria-pressed={id === p.id} onClick={() => edit(p)}><strong>{p.title}</strong><p>{p.tags.join(" · ")}</p></button>)}
      {hydrated && !prompts.length && <Empty description="保存常用提示词，生图和画布中都可调用" />}</section>
      <section className="prompt-editor"><label>名称<Input maxLength={160} value={title} onChange={e => setTitle(e.target.value)} /></label><label>提示词内容<Input.TextArea rows={12} maxLength={8000} value={content} onChange={e => setContent(e.target.value)} placeholder="描述产品、场景、构图和需要保留的细节" /></label><label>标签<Input value={tags} onChange={e => setTags(e.target.value)} placeholder="用逗号分隔" /></label>
      <div className="prompt-toolbar"><Button type="primary" icon={<Save size={14} />} disabled={!hydrated || !title.trim() || !content.trim()} onClick={save}>保存提示词</Button>{id && <Button danger icon={<Trash2 size={14} />} onClick={() => modal.confirm({ title: "删除这个提示词？", content: "画布中已经插入的文字仍会保留。", okText: "删除", cancelText: "取消", onOk: () => { removeAsset(id); edit(); } })}>删除</Button>}</div></section></div></main>;
}
