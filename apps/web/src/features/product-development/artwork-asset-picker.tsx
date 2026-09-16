"use client";
import Image from "next/image";
import { useRef, useState } from "react";
import { FileImage, Upload } from "lucide-react";
import { uploadArtworkMaterial } from "./artwork-material-actions";

export type PickableAsset = { id: string; fileName: string; mediaType: string };
export function ArtworkAssetPicker({
  assets,
  selected,
  onChange,
  onRefresh,
  limit = 30,
  imagesOnly = false,
  disabled = false,
}: {
  assets: PickableAsset[];
  selected: string[];
  onChange: (ids: string[]) => void;
  onRefresh: () => Promise<void>;
  limit?: number;
  imagesOnly?: boolean;
  disabled?: boolean;
}) {
  const [search, setSearch] = useState(""),
    [page, setPage] = useState(0),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [source, setSource] = useState("owned"),
    [reference, setReference] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const rows = assets.filter(
    (a) =>
      (!imagesOnly || ["image/png", "image/jpeg", "image/webp"].includes(a.mediaType)) &&
      a.fileName.toLowerCase().includes(search.toLowerCase()),
  );
  async function upload(file: File) {
    setBusy(true);
    setError("");
    try {
      const data = new FormData();
      data.set("file", file);
      data.set("source", source);
      data.set("reference", reference);
      const result = await uploadArtworkMaterial(data);
      if (result.error) throw new Error(result.error);
      await onRefresh();
      if (result.assetId && selected.length < limit)
        onChange([...new Set([...selected, result.assetId])]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "上传失败");
    } finally {
      setBusy(false);
      if (input.current) input.current.value = "";
    }
  }
  return (
    <section className="art-asset-picker" aria-label="授权素材选择">
      <div className="art-picker-search">
        <label>
          搜索素材
          <input
            value={search}
            placeholder="按文件名搜索"
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(0);
            }}
          />
        </label>
        <span>
          已选 {selected.length}/{limit} 项
        </span>
      </div>
      <div className="art-asset-grid">
        {rows.slice(page * 12, page * 12 + 12).map((a) => (
          <label key={a.id} className="art-asset-option">
            <input
              type="checkbox"
              checked={selected.includes(a.id)}
              disabled={disabled || busy || (!selected.includes(a.id) && selected.length >= limit)}
              onChange={(e) =>
                onChange(
                  e.target.checked ? [...selected, a.id] : selected.filter((id) => id !== a.id),
                )
              }
            />
            {["image/png", "image/jpeg", "image/webp"].includes(a.mediaType) ? (
              <Image
                src={`/api/product-development/assets/${a.id}/preview`}
                alt=""
                width={64}
                height={64}
                unoptimized
              />
            ) : (
              <FileImage size={32} />
            )}
            <span>{a.fileName}</span>
          </label>
        ))}
      </div>
      {!rows.length && <p className="canvas-help">没有匹配素材，可上传自有或已获授权的文件。</p>}
      {rows.length > 12 && (
        <div className="canvas-actions">
          <button type="button" disabled={!page} onClick={() => setPage((p) => p - 1)}>
            上一页
          </button>
          <span>
            {page + 1} / {Math.ceil(rows.length / 12)}
          </span>
          <button
            type="button"
            disabled={(page + 1) * 12 >= rows.length}
            onClick={() => setPage((p) => p + 1)}
          >
            下一页
          </button>
        </div>
      )}
      <details>
        <summary>上传授权素材</summary>
        <div className="art-upload">
          <label>
            素材来源
            <select value={source} onChange={(e) => setSource(e.target.value)}>
              <option value="owned">自有原创</option>
              <option value="licensed">已获许可</option>
              <option value="commissioned">委托创作</option>
              <option value="ai_generated">AI 生成</option>
            </select>
          </label>
          <label>
            来源说明
            <input
              value={reference}
              maxLength={500}
              placeholder="填写作者、许可或生成记录"
              onChange={(e) => setReference(e.target.value)}
            />
          </label>
          <input
            ref={input}
            aria-label="上传印花素材文件"
            type="file"
            hidden
            accept={
              imagesOnly
                ? "image/png,image/jpeg,image/webp"
                : "image/*,.psd,.svg,.pdf,.ttf,.otf,.zip"
            }
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void upload(file);
            }}
          />
          <button
            type="button"
            disabled={disabled || busy || !reference.trim()}
            onClick={() => input.current?.click()}
          >
            <Upload size={15} />
            {busy ? "正在上传…" : "选择文件并上传"}
          </button>
        </div>
        <p className="canvas-help">
          单文件最大 20 MiB。上传表示你确认填写的素材使用权；买家照片请在订单中上传。
        </p>
      </details>
      {error && (
        <p role="alert" className="canvas-notice error">
          {error}
        </p>
      )}
    </section>
  );
}
