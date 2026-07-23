"use client";
// 页面批注编辑器：在页面图上画框 / 涂鸦 / 加文字，坐标归一化保存，全员可见。
import { useRef, useState } from "react";
import { MarksOverlay, type Mark } from "./RichDoc";

const COLORS = ["#e53935", "#fb8c00", "#fdd835", "#43a047", "#1e88e5", "#8e24aa", "#111111"];
type Tool = "pen" | "rect" | "text";

export default function PageAnnotator({
  src, label, initial, author, onSave, onClose,
}: {
  src: string;
  label: string;
  initial: Mark[];
  author: string;
  onSave: (marks: Mark[]) => Promise<void>;
  onClose: () => void;
}) {
  const [marks, setMarks] = useState<Mark[]>(initial);
  const [tool, setTool] = useState<Tool>("pen");
  const [color, setColor] = useState(COLORS[0]);
  const [draft, setDraft] = useState<Mark | null>(null);
  const [pending, setPending] = useState<{ x: number; y: number; text: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");
  const areaRef = useRef<HTMLDivElement>(null);
  const drawing = useRef(false);

  function norm(e: React.PointerEvent) {
    const r = areaRef.current!.getBoundingClientRect();
    return {
      x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)),
      y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)),
    };
  }

  function onDown(e: React.PointerEvent) {
    if (pending || saving) return;
    const p = norm(e);
    if (tool === "text") { setPending({ x: p.x, y: p.y, text: "" }); return; }
    drawing.current = true;
    areaRef.current?.setPointerCapture(e.pointerId);
    setDraft(tool === "pen"
      ? { kind: "pen", pts: [p.x, p.y], color, by: author }
      : { kind: "rect", x: p.x, y: p.y, w: 0, h: 0, color, by: author });
  }

  function onMove(e: React.PointerEvent) {
    if (!drawing.current || !draft) return;
    const p = norm(e);
    if (draft.kind === "pen") setDraft({ ...draft, pts: [...draft.pts, p.x, p.y] });
    else if (draft.kind === "rect") setDraft({ ...draft, w: p.x - draft.x, h: p.y - draft.y });
  }

  function onUp(e: React.PointerEvent) {
    if (!drawing.current) return;
    drawing.current = false;
    try { areaRef.current?.releasePointerCapture(e.pointerId); } catch { /* 已释放 */ }
    const m = draft;
    setDraft(null);
    if (!m) return;
    if (m.kind === "rect") {
      const x = Math.min(m.x, m.x + m.w), y = Math.min(m.y, m.y + m.h);
      const w = Math.abs(m.w), h = Math.abs(m.h);
      if (w < 0.005 || h < 0.005) return; // 误点，忽略
      setMarks((prev) => [...prev, { ...m, x, y, w, h }]);
      return;
    }
    if (m.kind === "pen" && m.pts.length < 4) return;
    setMarks((prev) => [...prev, m]);
  }

  function commitText() {
    if (!pending) return;
    const t = pending.text.trim();
    if (t) setMarks((prev) => [...prev, { kind: "text", x: pending.x, y: pending.y, text: t, color, by: author }]);
    setPending(null);
  }

  async function save() {
    setSaving(true); setErr("");
    try { await onSave(marks); }
    catch (e) { setErr(e instanceof Error ? e.message : "保存失败"); setSaving(false); }
  }

  const shown = draft ? [...marks, draft] : marks;

  return (
    <div className="annot-backdrop" onClick={(e) => { if (e.target === e.currentTarget && !saving) onClose(); }}>
      <div className="annot-modal">
        <div className="annot-bar">
          <strong className="annot-title">{label} · 批注</strong>
          <div className="annot-tools">
            <button type="button" className={`btn btn-sm ${tool === "pen" ? "" : "btn-ghost"}`} onClick={() => setTool("pen")} title="涂鸦笔">✏️ 涂鸦</button>
            <button type="button" className={`btn btn-sm ${tool === "rect" ? "" : "btn-ghost"}`} onClick={() => setTool("rect")} title="框选">▢ 框选</button>
            <button type="button" className={`btn btn-sm ${tool === "text" ? "" : "btn-ghost"}`} onClick={() => setTool("text")} title="文字批注">T 文字</button>
            <span className="annot-colors">
              {COLORS.map((c) => (
                <button key={c} type="button" className={`swatch ${color === c ? "on" : ""}`} style={{ background: c }}
                  onClick={() => setColor(c)} title={`颜色 ${c}`} />
              ))}
            </span>
            <button type="button" className="btn btn-ghost btn-sm" disabled={!marks.length} onClick={() => setMarks((p) => p.slice(0, -1))}>撤销</button>
            <button type="button" className="btn btn-ghost btn-sm" disabled={!marks.length} onClick={() => setMarks([])}>清除</button>
          </div>
          <div className="annot-actions">
            <button type="button" className="btn btn-ghost btn-sm" disabled={saving} onClick={onClose}>取消</button>
            <button type="button" className="btn btn-sm" disabled={saving} onClick={save}>{saving ? "保存中…" : "保存批注"}</button>
          </div>
        </div>
        {err && <div className="annot-err">{err}</div>}
        <div className="annot-canvas-wrap">
          <div
            ref={areaRef}
            className={`annot-canvas tool-${tool}`}
            onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}
          >
            <img src={src} alt={label} draggable={false} />
            <MarksOverlay marks={shown} />
            {pending && (
              <div className="annot-text-input" style={{ left: `${pending.x * 100}%`, top: `${pending.y * 100}%` }}
                onPointerDown={(e) => e.stopPropagation()}>
                <input
                  className="input" autoFocus value={pending.text} placeholder="输入批注文字"
                  onChange={(e) => setPending({ ...pending, text: e.target.value })}
                  onKeyDown={(e) => { if (e.key === "Enter") commitText(); if (e.key === "Escape") setPending(null); }}
                />
                <button type="button" className="btn btn-sm" onClick={commitText}>确定</button>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => setPending(null)}>取消</button>
              </div>
            )}
          </div>
        </div>
        <div className="annot-hint">
          共 {marks.length} 处批注 · 在图上按住拖动即可{tool === "text" ? "；选「文字」后点击图上位置输入文字" : "作画"}。批注保存后全员可见，并会出现在审校报告中。
        </div>
      </div>
    </div>
  );
}
