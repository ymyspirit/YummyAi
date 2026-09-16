import { Button, Dropdown } from "antd";
import { Download, FolderOpen, Menu, PanelLeftClose, PanelLeftOpen, Plus, Redo2, Trash2, Undo2, Upload } from "lucide-react";
import { useCanvasSidePanelStore } from "@/stores/use-canvas-side-panel-store";
import type { CanvasTopBar as UpstreamCanvasTopBar } from "../vendor/src/components/canvas/canvas-top-bar";

type Props = Parameters<typeof UpstreamCanvasTopBar>[0];

export function CanvasTopBar(props: Props) {
  const expanded = useCanvasSidePanelStore(state => state.panelOpen);
  const toggle = useCanvasSidePanelStore(state => state.togglePanel);
  return <div className="studio-canvas-toolbar">
    <button type="button" onClick={toggle} aria-label={expanded ? "收起画布面板" : "展开画布面板"}>{expanded ? <PanelLeftClose size={16} /> : <PanelLeftOpen size={16} />}</button>
    <Dropdown trigger={["click"]} menu={{ items: [
      { key: "projects", label: "画布列表", icon: <FolderOpen size={15} />, onClick: props.onProjects },
      { key: "new", label: "新建画布", icon: <Plus size={15} />, onClick: props.onCreateProject },
      { key: "import", label: "上传资产", icon: <Upload size={15} />, onClick: props.onImportImage },
      { key: "export", label: "导出当前画布", icon: <Download size={15} />, onClick: props.onExportProject },
      { type: "divider" },
      { key: "delete", label: "删除当前画布", icon: <Trash2 size={15} />, danger: true, onClick: props.onDeleteProject },
    ] }}><button type="button" aria-label="画布菜单"><Menu size={16} /></button></Dropdown>
    {props.isTitleEditing ? <input autoFocus aria-label="画布名称" value={props.titleDraft} onChange={event => props.onTitleDraftChange(event.target.value)} onBlur={props.onFinishTitleEditing} onKeyDown={event => { if (event.key === "Enter") props.onFinishTitleEditing(); if (event.key === "Escape") props.onCancelTitleEditing(); }} /> : <button type="button" className="studio-canvas-title" title="双击重命名画布" onDoubleClick={props.onStartTitleEditing}>{props.title}</button>}
    <div className="studio-canvas-history"><Button type="text" aria-label="撤销" disabled={!props.canUndo} icon={<Undo2 size={15} />} onClick={props.onUndo} /><Button type="text" aria-label="重做" disabled={!props.canRedo} icon={<Redo2 size={15} />} onClick={props.onRedo} /></div>
  </div>;
}
