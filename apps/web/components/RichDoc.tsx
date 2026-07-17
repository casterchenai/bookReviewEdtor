"use client";
// 结构化块的渲染与编辑：标题 / 正文 / 注记 / 列表 / 表格 / 图片 / PDF 页
import { useState } from "react";

export type Block =
  | { type: "heading"; level: number; text: string }
  | { type: "para"; text: string }
  | { type: "note"; text: string }
  | { type: "list"; ordered: boolean; items: string[] }
  | { type: "table"; rows: { cells: string[]; header: boolean }[] }
  | { type: "image"; src: string; alt: string }
  | { type: "page"; pageKind: "text" | "gallery"; label: string };

export function parseDoc(docJson: string): Block[] | null {
  if (!docJson) return null;
  try {
    const d = JSON.parse(docJson);
    return Array.isArray(d?.blocks) ? (d.blocks as Block[]) : null;
  } catch { return null; }
}

export function blockPreview(b: Block): string {
  switch (b.type) {
    case "heading": case "para": case "note": return b.text;
    case "list": return b.items.join("；");
    case "table": return b.rows[0]?.cells.join(" | ") ?? "表格";
    case "image": return b.alt || "图片";
    case "page": return `${b.label}·${b.pageKind === "gallery" ? "图册页" : "文本页"}`;
  }
}

const BLOCK_TAG: Record<string, string> = {
  heading: "标题", note: "注记", list: "列表", table: "表格", image: "图片", page: "页",
};

// ===== 只读渲染（可点击选中以评论）=====
export function RichDocView({
  blocks, selectedIndex, onSelect, countByIndex, idPrefix, renderAfter,
}: {
  blocks: Block[];
  selectedIndex: number | null;
  onSelect: (i: number) => void;
  countByIndex: Map<number, number>;
  idPrefix?: string;
  renderAfter?: (i: number) => React.ReactNode;
}) {
  return (
    <div className="manuscript-body rich">
      {blocks.map((b, i) => (
        <div key={i}>
          <div
            id={idPrefix ? `${idPrefix}${i}` : undefined}
            className={`rich-block ${selectedIndex === i ? "selected" : ""} ${countByIndex.has(i) ? "has-comments" : ""}`}
            data-count={countByIndex.get(i) ?? ""}
            title="点击以对此块发表审阅意见"
            onClick={() => onSelect(i)}
          >
            <span className="p-index">¶{i + 1}{b.type !== "para" && b.type !== "heading" ? ` ${BLOCK_TAG[b.type] ?? ""}` : ""}</span>
            <BlockBody b={b} />
          </div>
          {renderAfter?.(i)}
        </div>
      ))}
    </div>
  );
}

function BlockBody({ b }: { b: Block }) {
  switch (b.type) {
    case "heading":
      return b.level <= 1 ? <h2 className="rb-h1">{b.text}</h2> : b.level === 2 ? <h3 className="rb-h2">{b.text}</h3> : <h4 className="rb-h3">{b.text}</h4>;
    case "para": return <p className="rb-p">{b.text}</p>;
    case "note": return <div className="rb-note">{b.text}</div>;
    case "list":
      return b.ordered
        ? <ol className="rb-list">{b.items.map((it, i) => <li key={i}>{it}</li>)}</ol>
        : <ul className="rb-list">{b.items.map((it, i) => <li key={i}>{it}</li>)}</ul>;
    case "table":
      return (
        <div className="rb-table-wrap">
          <table className="rb-table">
            <tbody>
              {b.rows.map((r, ri) => (
                <tr key={ri}>{r.cells.map((c, ci) => r.header ? <th key={ci}>{c}</th> : <td key={ci}>{c}</td>)}</tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case "image":
      return b.src
        ? <img className="rb-img" src={b.src} alt={b.alt} />
        : <div className="rb-img-ph">🖼 {b.alt || "（图片）"}</div>;
    case "page":
      return <div className={`rb-page ${b.pageKind}`}>{b.label} · {b.pageKind === "gallery" ? "图册页" : "文本页"}</div>;
  }
}

// ===== 块编辑器（受控）=====
export function RichDocEditor({ blocks, onChange }: { blocks: Block[]; onChange: (b: Block[]) => void }) {
  const [open, setOpen] = useState<number | null>(null);

  function update(i: number, nb: Block) {
    const next = blocks.slice(); next[i] = nb; onChange(next);
  }
  function remove(i: number) {
    if (!confirm("删除此内容块？")) return;
    onChange(blocks.filter((_, x) => x !== i));
  }

  return (
    <div className="doc-editor">
      {blocks.map((b, i) => (
        <div key={i} className="de-block">
          <div className="de-head">
            <span className="de-tag">¶{i + 1} {BLOCK_TAG[b.type] ?? "正文"}</span>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setOpen(open === i ? null : i)}>
              {open === i ? "收起" : "编辑"}
            </button>
            <button type="button" className="btn btn-danger btn-sm" onClick={() => remove(i)}>删除</button>
          </div>
          {open === i ? <BlockEditor b={b} onChange={(nb) => update(i, nb)} /> : <div className="de-preview">{blockPreview(b).slice(0, 120)}</div>}
        </div>
      ))}
    </div>
  );
}

function BlockEditor({ b, onChange }: { b: Block; onChange: (b: Block) => void }) {
  if (b.type === "heading" || b.type === "para" || b.type === "note") {
    return <textarea className="textarea" rows={b.type === "note" ? 3 : 4} value={b.text} onChange={(e) => onChange({ ...b, text: e.target.value })} />;
  }
  if (b.type === "list") {
    return (
      <textarea
        className="textarea" rows={Math.max(3, b.items.length)} value={b.items.join("\n")}
        onChange={(e) => onChange({ ...b, items: e.target.value.split("\n").map((s) => s.trim()).filter(Boolean) })}
        placeholder="每行一个列表项"
      />
    );
  }
  if (b.type === "table") {
    return (
      <div className="rb-table-wrap">
        <table className="rb-table edit">
          <tbody>
            {b.rows.map((r, ri) => (
              <tr key={ri}>
                {r.cells.map((c, ci) => {
                  const Cell = r.header ? "th" : "td";
                  return (
                    <Cell key={ci}>
                      <input
                        className="cell-input" value={c}
                        onChange={(e) => {
                          const rows = b.rows.map((row, x) => x !== ri ? row : { ...row, cells: row.cells.map((cc, y) => y === ci ? e.target.value : cc) });
                          onChange({ ...b, rows });
                        }}
                      />
                    </Cell>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }
  if (b.type === "image") {
    return (
      <div>
        {b.src ? <img className="rb-img" src={b.src} alt={b.alt} /> : <div className="rb-img-ph">🖼 无图片数据</div>}
        <input className="input" style={{ marginTop: 8 }} value={b.alt} onChange={(e) => onChange({ ...b, alt: e.target.value })} placeholder="图片说明 / 替代文字" />
      </div>
    );
  }
  if (b.type === "page") {
    return (
      <select className="select" value={b.pageKind} onChange={(e) => onChange({ ...b, pageKind: e.target.value as "text" | "gallery" })}>
        <option value="text">文本页</option>
        <option value="gallery">图册页</option>
      </select>
    );
  }
  return null;
}
