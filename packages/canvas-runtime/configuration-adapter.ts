import { fileURLToPath } from "node:url";

const local = (name: string) => fileURLToPath(new URL(`./src/${name}`, import.meta.url)).replaceAll("\\", "/");
function anchor(code: string, before: string, after: string) {
  if (!code.includes(before)) throw new Error(`Configuration adapter requires upstream review: ${before.slice(0, 90)}`);
  return code.replace(before, after);
}
function section(code: string, start: string, end: string, replacement: string) {
  const from = code.indexOf(start), to = code.indexOf(end, from + start.length);
  if (from < 0 || to < 0) throw new Error(`Configuration adapter section requires upstream review: ${start}`);
  return code.slice(0, from) + replacement + code.slice(to);
}

/** Keep upstream files byte-identical. All ERP configuration substitutions live here. */
export function adaptConfiguration(code: string, name: string): string {
  if (name === "services/api/image.ts") {
    code = `import { discoverChannelModels } from "${local("settings-transport.ts")}";\n${code}`;
    return anchor(code, "return fetchImageModels({ baseUrl: channel.baseUrl, apiKey: channel.apiKey, apiFormat: channel.apiFormat });", "return discoverChannelModels(channel);");
  }
  if (name === "components/layout/model-select-modal.tsx") {
    code = `import { isSavedSettingsChannel } from "${local("settings-transport.ts")}";\nimport { notify } from "${local("rpc.ts")}";\n${code}`;
    code = anchor(code, '    const currentList = ', '    useEffect(() => { notify("settings.selection", { dirty: open && (!!manual.trim() || selected.size !== selectedNames.length || selectedNames.some(name => !selected.has(name))), busy: loading }); }, [open, manual, selected, selectedNames, loading]);\n\n    const currentList = ');
    code = anchor(code, '            onCancel={onClose}', '            onCancel={() => { if (!loading) onClose(); }}\n            maskClosable={!loading}\n            keyboard={!loading}');
    code = anchor(code, '<Button key="cancel" onClick={onClose}>', '<Button key="cancel" disabled={loading} onClick={onClose}>');
    code = anchor(code, '<Button key="confirm" type="primary" onClick={confirm}>', '<Button key="confirm" type="primary" disabled={loading} onClick={confirm}>');
    code = anchor(code, "if (!channel.baseUrl.trim() || !channel.apiKey.trim())", "if (!channel.baseUrl.trim() || (!channel.apiKey.trim() && !isSavedSettingsChannel(channel.id)))");
    code = anchor(code, '<div className="mt-2 text-xs text-stone-500">{t("config.modelSelect.description")}</div>', '<div className="mt-2 text-xs text-stone-500">读取渠道模型目录，不会发起生成。列表仅代表渠道已列出；用途和实际调用能力仍需核对。</div>');
    code = anchor(code, 'const name = manual.trim();', 'const name = manual.trim();\n        if (name && !/^[a-zA-Z0-9_./:-]{1,120}$/.test(name)) { message.error("模型名称格式无效，最多 120 个字符"); return; }');
    return anchor(code, 'className="truncate" title={name}', 'className="break-all" title={name}');
  }
  if (name !== "components/layout/channel-editor-drawer.tsx") return code;
  code = `import { isSavedSettingsChannel } from "${local("settings-transport.ts")}";\nimport { notify } from "${local("rpc.ts")}";\n${code}`;
  code = anchor(code, 'import { Button, Drawer', 'import { App, Button, Drawer');
  code = anchor(code, 'import { useEffect, useState }', 'import { useEffect, useMemo, useState }');
  code = anchor(code, 'import { ModelScriptEditor } from "./model-script-editor";', '');
  code = anchor(code, '    const [scriptTarget, setScriptTarget] = useState<ScriptTarget | null>(null);', '    const { message } = App.useApp();\n    const [saving, setSaving] = useState(false);\n    const selectedNames = useMemo(() => draft?.models.map(model => model.name) ?? [], [draft?.models]);\n    useEffect(() => { notify("settings.draft", { dirty: open && JSON.stringify(draft) !== JSON.stringify(channel), busy: saving }); }, [draft, channel, open, saving]);');
  code = anchor(code, '        { label: "Gemini", value: "gemini" },', '');
  code = anchor(code, '["image", "video", "text", "audio"]', '["image", "video", "text"]');
  code = section(code, '    const setScript = ', '    const removeModel = ', '');
  code = section(code, '    const save = () => {', '    return (', `    const save = async () => {
        if (saving) return;
        setSaving(true);
        try {
            await onSave({ ...draft, name: draft.name.trim(), models: normalizeChannelModels(draft.models) });
            onClose();
        } catch (cause) { message.error(cause instanceof Error ? cause.message : "渠道保存失败"); }
        finally { setSaving(false); }
    };

`);
  code = anchor(code, '            onClose={onClose}', '            onClose={() => { if (!saving) onClose(); }}\n            maskClosable={!saving}\n            keyboard={!saving}');
  code = anchor(code, '<Button onClick={onClose}>', '<Button disabled={saving} onClick={onClose}>');
  code = anchor(code, '<Button type="primary" onClick={save}>', '<Button aria-label="保存渠道" type="primary" loading={saving} onClick={() => void save()}>');
  code = anchor(code, '<Input value={draft.name}', '<Input disabled={saving} value={draft.name}');
  code = anchor(code, '<Input value={draft.baseUrl}', '<Input disabled={saving} value={draft.baseUrl}');
  code = anchor(code, '<Input.Password value={draft.apiKey}', '<Input.Password disabled={saving} value={draft.apiKey}');
  code = anchor(code, '<Select className="w-full"', '<Select disabled={saving} className="w-full"');
  code = anchor(code, '<Segmented size="small"', '<Segmented disabled={saving} size="small"');
  code = anchor(code, '<Button type="primary" icon={<ListPlus', '<Button disabled={saving} type="primary" icon={<ListPlus');
  code = anchor(code, 'placeholder="sk-..."', 'autoComplete="new-password" placeholder={isSavedSettingsChannel(draft.id) ? "凭据已保存；留空保留原 Key" : "填写 OpenAI API Key"}');
  code = anchor(code, '{t("config.channelEditor.modelDescription", { count: draft.models.length })}', '{`已选择 ${draft.models.length} 个模型。用途按名称建议，请核对；添加不代表调用已验证。`}');
  code = section(code, '                                <Button size="small" type={model.script', '                                <Button size="small" danger', '');
  code = anchor(code, '<Button size="small" danger', '<Button disabled={saving} aria-label={`移除 ${model.name}`} size="small" danger');
  code = anchor(code, 'selectedNames={draft.models.map((model) => model.name)}', 'selectedNames={selectedNames}');
  code = section(code, '            <ModelScriptEditor', '        </Drawer>', '');
  code = anchor(code, 'className="min-w-0 flex-1 truncate text-sm"', 'className="min-w-0 flex-1 break-all text-sm"');
  return code;
}
