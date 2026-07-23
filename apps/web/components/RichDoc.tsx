"use client";
// 结构化块的渲染与编辑：标题 / 正文 / 注记 / 列表 / 表格 / 图片 / PDF 页
import { useState } from "react";
import { useConfirm } from "@/components/ConfirmProvider";

// 图片/页面上的持久批注（归一化坐标 0..1，随图缩放）
export type Mark =
  | { kind: "rect"; x: number; y: number; w: number; h: number; color: string; by?: string }
  | { kind: "pen"; pts: number[]; color: string; by?: string }
  | { kind: "text"; x: number; y: number; text: string; color: string; by?: string };

export type Block =
  | { type: "heading"; level: number; text: string }
  | { type: "para"; text: string }
  | { type: "note"; text: string }
  | { type: "list"; ordered: boolean; items: string[] }
  | { type: "table"; rows: { cells: string[]; header: boolean }[] }
  // 含 page 时为 PDF「页面块」：整页图 + 隐藏的识别文字 ocr + 持久批注 marks
  | { type: "image"; src: string; alt: string; page?: number; ocr?: string; marks?: Mark[] }
  | { type: "page"; pageKind: "text" | "gallery"; label: string };

// 批注覆盖层：形状走 SVG（non-scaling-stroke 保证线宽不被拉伸），文字用绝对定位避免变形
export function MarksOverlay({ marks }: { marks: Mark[] }) {
  if (!marks.length) return null;
  return (
    <>
      <svg className="marks-svg" viewBox="0 0 1000 1000" preserveAspectRatio="none" aria-hidden>
        {marks.map((m, i) => {
          if (m.kind === "rect") {
            return <rect key={i} x={m.x * 1000} y={m.y * 1000} width={m.w * 1000} height={m.h * 1000}
              fill="none" stroke={m.color} strokeWidth={2} vectorEffect="non-scaling-stroke" />;
          }
          if (m.kind === "pen") {
            const pts: string[] = [];
            for (let k = 0; k + 1 < m.pts.length; k += 2) pts.push(`${m.pts[k] * 1000},${m.pts[k + 1] * 1000}`);
            return <polyline key={i} points={pts.join(" ")} fill="none" stroke={m.color} strokeWidth={2}
              strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />;
          }
          return null;
        })}
      </svg>
      {marks.map((m, i) => m.kind === "text" ? (
        <span key={`t${i}`} className="mark-text" style={{ left: `${m.x * 100}%`, top: `${m.y * 100}%`, color: m.color, borderColor: m.color }}>
          {m.text}
        </span>
      ) : null)}
    </>
  );
}

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
    case "image":
      return b.page
        ? `${b.alt || `第 ${b.page} 页`}${(b.ocr ?? "").trim() ? "（含识别文字）" : ""}`
        : (b.alt || "图片");
    case "page": return `${b.label}·${b.pageKind === "gallery" ? "图册页" : "文本页"}`;
  }
}

const BLOCK_TAG: Record<string, string> = {
  heading: "标题", note: "注记", list: "列表", table: "表格", image: "图片", page: "页",
};

// 将文本中匹配 term 的部分用 <mark> 高亮（大小写不敏感）
export function renderHighlight(text: string, term: string): React.ReactNode {
  if (!term) return text;
  const lower = text.toLowerCase(), t = term.toLowerCase();
  const out: React.ReactNode[] = [];
  let i = 0, k = 0;
  while (i <= text.length) {
    const p = lower.indexOf(t, i);
    if (p < 0) { out.push(text.slice(i)); break; }
    if (p > i) out.push(text.slice(i, p));
    out.push(<mark key={k++} className="search-hit">{text.slice(p, p + term.length)}</mark>);
    i = p + term.length;
  }
  return out;
}

// ===== 只读渲染（可点击选中以评论）=====
export function RichDocView({
  blocks, selectedIndex, onSelect, countByIndex, idPrefix, renderAfter, highlight = "",
  onAnnotate, onOcrPage, ocrBusyIndex = null, canEdit = false,
}: {
  blocks: Block[];
  selectedIndex: number | null;
  onSelect: (i: number) => void;
  countByIndex: Map<number, number>;
  idPrefix?: string;
  renderAfter?: (i: number) => React.ReactNode;
  highlight?: string;
  onAnnotate?: (i: number) => void;      // 打开该页的批注编辑器
  onOcrPage?: (i: number) => void;       // 识别该页文字
  ocrBusyIndex?: number | null;
  canEdit?: boolean;                     // 是否显示批注/识别按钮
}) {
  const [lightbox, setLightbox] = useState<string | null>(null);
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
            <span className="p-index">
              ¶{i + 1}{b.type !== "para" && b.type !== "heading" ? ` ${b.type === "image" && b.page ? "页" : BLOCK_TAG[b.type] ?? ""}` : ""}
            </span>
            <BlockBody
              b={b} hl={highlight} onImageClick={setLightbox}
              onAnnotate={onAnnotate ? () => onAnnotate(i) : undefined}
              onOcrPage={onOcrPage ? () => onOcrPage(i) : undefined}
              ocrBusy={ocrBusyIndex === i} canEdit={canEdit}
            />
          </div>
          {renderAfter?.(i)}
        </div>
      ))}
      {lightbox && (
        <div className="lightbox" onClick={() => setLightbox(null)}>
          <img src={lightbox} alt="放大查看" onClick={(e) => e.stopPropagation()} />
          <button className="lightbox-close" onClick={() => setLightbox(null)}>✕ 关闭</button>
        </div>
      )}
    </div>
  );
}

function BlockBody({ b, hl = "", onImageClick, onAnnotate, onOcrPage, ocrBusy = false, canEdit = false }: {
  b: Block; hl?: string; onImageClick?: (src: string) => void;
  onAnnotate?: () => void; onOcrPage?: () => void; ocrBusy?: boolean; canEdit?: boolean;
}) {
  const H = (t: string) => hl ? renderHighlight(t, hl) : t;
  switch (b.type) {
    case "heading":
      return b.level <= 1 ? <h2 className="rb-h1">{H(b.text)}</h2> : b.level === 2 ? <h3 className="rb-h2">{H(b.text)}</h3> : <h4 className="rb-h3">{H(b.text)}</h4>;
    case "para": return <p className="rb-p">{H(b.text)}</p>;
    case "note": return <div className="rb-note">{H(b.text)}</div>;
    case "list":
      return b.ordered
        ? <ol className="rb-list">{b.items.map((it, i) => <li key={i}>{H(it)}</li>)}</ol>
        : <ul className="rb-list">{b.items.map((it, i) => <li key={i}>{H(it)}</li>)}</ul>;
    case "table":
      return (
        <div className="rb-table-wrap">
          <table className="rb-table">
            <tbody>
              {b.rows.map((r, ri) => (
                <tr key={ri}>{r.cells.map((c, ci) => r.header ? <th key={ci}>{H(c)}</th> : <td key={ci}>{H(c)}</td>)}</tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case "image": {
      // PDF 页面块：整页图 + 图上工具条；点击图片本身仍冒泡到块，弹出评审对话
      if (b.page) {
        const marks = b.marks ?? [];
        return (
          <div className="rb-page-block">
            <div className="rb-page-label">
              {b.alt || `第 ${b.page} 页`}
              {marks.length > 0 && <span className="rb-page-chip mk">{marks.length} 处批注</span>}
              {(b.ocr ?? "").trim() && <span className="rb-page-chip ocr">已识别文字</span>}
            </div>
            <div className="rb-page-figure">
              {b.src
                ? <img className="rb-page-img" src={b.src} alt={b.alt} />
                : <div className="rb-img-ph">🖼 本页未渲染图片</div>}
              <MarksOverlay marks={marks} />
              <div className="rb-page-tools" onClick={(e) => e.stopPropagation()}>
                {b.src && <button type="button" className="pg-tool" title="放大查看" onClick={() => onImageClick?.(b.src)}>🔍</button>}
                {canEdit && b.src && onAnnotate && (
                  <button type="button" className="pg-tool" title="标注 / 涂鸦笔" onClick={onAnnotate}>✏️</button>
                )}
                {canEdit && b.src && onOcrPage && (
                  <button type="button" className="pg-tool" title="识别本页文字（供 AI 审校，不改动图片）" disabled={ocrBusy} onClick={onOcrPage}>
                    {ocrBusy ? "…" : "🔤"}
                  </button>
                )}
              </div>
            </div>
          </div>
        );
      }
      return b.src
        ? <img className="rb-img zoomable" src={b.src} alt={b.alt} title="点击放大" onClick={(e) => { e.stopPropagation(); onImageClick?.(b.src); }} />
        : <div className="rb-img-ph">🖼 {b.alt || "（图片）"}</div>;
    }
    case "page":
      return <div className={`rb-page ${b.pageKind}`}>{b.label} · {b.pageKind === "gallery" ? "图册页" : "文本页"}</div>;
  }
}

// ===== 块编辑器（受控）=====
export function RichDocEditor({ blocks, onChange }: { blocks: Block[]; onChange: (b: Block[]) => void }) {
  const confirm = useConfirm();
  const [open, setOpen] = useState<number | null>(null);

  function update(i: number, nb: Block) {
    const next = blocks.slice(); next[i] = nb; onChange(next);
  }
  async function remove(i: number) {
    if (!(await confirm({ title: "删除内容块", body: "删除此内容块？", confirmText: "删除", danger: true }))) return;
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
        <input className="input" style={{ marginTop: 8 }} value={b.alt} onChange={(e) => onChange({ ...b, alt: e.target.value })}
          placeholder={b.page ? "页标签，例如：第 3 页" : "图片说明 / 替代文字"} />
        {b.page && (
          <>
            <div className="muted small" style={{ marginTop: 8 }}>
              识别文字（不在正文显示，仅供 AI 审校与报告引用，可在此更正识别错误）
            </div>
            <textarea className="textarea" rows={5} value={b.ocr ?? ""} onChange={(e) => onChange({ ...b, ocr: e.target.value })}
              placeholder="尚未识别。可在页面图上点「🔤」识别，或在此手工录入。" />
          </>
        )}
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
