"use client";
// 每本书的 AI 审校智能体管理：增删改 + AI 读稿推荐一键采纳
import { useCallback, useEffect, useState } from "react";
import { api, CATEGORY_LABEL } from "@/lib/api";

export type Agent = {
  id: string; name: string; role: string; systemPrompt: string;
  category: string; enabled: boolean; order: number;
};
type Suggested = { name: string; role: string; systemPrompt: string; category: string };

const CATS = ["GENERAL", "GRAMMAR", "WORDING", "LOGIC", "STYLE", "MARKET", "STANDARD"];

export default function AgentManager({ projectId, onFlash }: { projectId: string; onFlash: (m: string) => void }) {
  const [agents, setAgents] = useState<Agent[] | null>(null);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Partial<Agent> | null>(null);
  const [advisorBusy, setAdvisorBusy] = useState(false);
  const [proposed, setProposed] = useState<Suggested[] | null>(null);
  const [picked, setPicked] = useState<Set<number>>(new Set());

  const load = useCallback(() => {
    api<Agent[]>(`/projects/${projectId}/agents`).then(setAgents).catch(() => setAgents([]));
  }, [projectId]);
  useEffect(() => { if (open) load(); }, [open, load]);

  async function saveAgent() {
    if (!editing?.name?.trim() || !editing?.systemPrompt?.trim()) { onFlash("请填写名称与审校指令"); return; }
    try {
      const body = { name: editing.name, role: editing.role ?? "", systemPrompt: editing.systemPrompt, category: editing.category ?? "GENERAL", enabled: editing.enabled ?? true };
      if (editing.id) await api(`/projects/${projectId}/agents/${editing.id}`, { method: "PATCH", body });
      else await api(`/projects/${projectId}/agents`, { method: "POST", body });
      setEditing(null); load(); onFlash("智能体已保存");
    } catch (err) { onFlash(err instanceof Error ? err.message : "保存失败"); }
  }

  async function toggle(a: Agent) {
    try { await api(`/projects/${projectId}/agents/${a.id}`, { method: "PATCH", body: { enabled: !a.enabled } }); load(); }
    catch (err) { onFlash(err instanceof Error ? err.message : "操作失败"); }
  }
  async function remove(a: Agent) {
    if (!confirm(`删除智能体「${a.name}」？`)) return;
    try { await api(`/projects/${projectId}/agents/${a.id}`, { method: "DELETE" }); load(); onFlash("已删除"); }
    catch (err) { onFlash(err instanceof Error ? err.message : "删除失败"); }
  }

  async function runAdvisor() {
    setAdvisorBusy(true);
    try {
      const r = await api<{ agents: Suggested[] }>(`/ai/projects/${projectId}/suggest-agents`, { method: "POST" });
      setProposed(r.agents); setPicked(new Set(r.agents.map((_, i) => i)));
      onFlash(`AI 读稿完成，推荐 ${r.agents.length} 个智能体`);
    } catch (err) { onFlash(err instanceof Error ? err.message : "AI 读稿失败"); }
    finally { setAdvisorBusy(false); }
  }
  async function adoptPicked() {
    if (!proposed) return;
    const chosen = proposed.filter((_, i) => picked.has(i));
    if (chosen.length === 0) { onFlash("请至少选择一个"); return; }
    try {
      await api(`/projects/${projectId}/agents/batch`, { method: "POST", body: { agents: chosen } });
      setProposed(null); load(); onFlash(`已采纳 ${chosen.length} 个智能体`);
    } catch (err) { onFlash(err instanceof Error ? err.message : "采纳失败"); }
  }

  return (
    <div className="card">
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <h2 style={{ flex: 1, margin: 0 }}>AI 审校智能体</h2>
        <button className="btn btn-ghost btn-sm" onClick={() => setOpen((v) => !v)}>{open ? "收起" : "管理"}</button>
      </div>
      <div className="muted small" style={{ marginTop: 4 }}>为本书定制不同职责的 AI 审校员；审校时可指定某个智能体。</div>

      {open && (
        <div style={{ marginTop: 10 }}>
          <div style={{ display: "flex", gap: 8, marginBottom: 10, flexWrap: "wrap" }}>
            <button className="btn btn-sm" disabled={advisorBusy} onClick={runAdvisor}>{advisorBusy ? "AI 读稿中…" : "🤖 AI 读稿推荐智能体"}</button>
            <button className="btn btn-ghost btn-sm" onClick={() => setEditing({ category: "GENERAL", enabled: true })}>＋ 手动新建</button>
          </div>

          {agents === null ? <div className="empty small">加载中…</div> : agents.length === 0 ? (
            <div className="muted small">还没有智能体。点「AI 读稿推荐」让 AI 阅读本书后为你设计一套，或手动新建。</div>
          ) : agents.map((a) => (
            <div key={a.id} className="revision-item" style={{ alignItems: "flex-start" }}>
              <div style={{ flex: 1 }}>
                <div><strong>{a.name}</strong> <span className="badge badge-gray">{CATEGORY_LABEL[a.category] ?? a.category}</span> {!a.enabled && <span className="badge">已停用</span>}</div>
                {a.role && <div className="muted small">{a.role}</div>}
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 4, alignItems: "flex-end" }}>
                <div style={{ display: "flex", gap: 4 }}>
                  <button className="btn btn-ghost btn-sm" onClick={() => setEditing(a)}>编辑</button>
                  <button className="btn btn-ghost btn-sm" onClick={() => toggle(a)}>{a.enabled ? "停用" : "启用"}</button>
                  <button className="btn btn-danger btn-sm" onClick={() => remove(a)}>删除</button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* 编辑/新建智能体 */}
      {editing && (
        <div className="modal-overlay" onClick={() => setEditing(null)}>
          <div className="card modal-card" style={{ maxWidth: 600 }} onClick={(e) => e.stopPropagation()}>
            <h2 style={{ marginTop: 0 }}>{editing.id ? "编辑智能体" : "新建智能体"}</h2>
            <div className="field"><label>名称</label><input className="input" value={editing.name ?? ""} onChange={(e) => setEditing({ ...editing, name: e.target.value })} placeholder="如：会计准则合规审查" /></div>
            <div className="field"><label>角色定位（一句话）</label><input className="input" value={editing.role ?? ""} onChange={(e) => setEditing({ ...editing, role: e.target.value })} placeholder="如：以《民间非营利组织会计制度》为准绳核查账务处理" /></div>
            <div className="field"><label>意见归类</label>
              <select className="select" value={editing.category ?? "GENERAL"} onChange={(e) => setEditing({ ...editing, category: e.target.value })}>
                {CATS.map((c) => <option key={c} value={c}>{CATEGORY_LABEL[c] ?? c}</option>)}
              </select>
            </div>
            <div className="field"><label>审校指令（该智能体的“技能”）</label>
              <textarea className="textarea" rows={7} value={editing.systemPrompt ?? ""} onChange={(e) => setEditing({ ...editing, systemPrompt: e.target.value })} placeholder="写明这个智能体以什么视角、重点查什么、依据什么标准审校本书…" />
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <button className="btn" onClick={saveAgent}>保存</button>
              <button className="btn btn-ghost" onClick={() => setEditing(null)}>取消</button>
            </div>
          </div>
        </div>
      )}

      {/* AI 读稿推荐结果 */}
      {proposed && (
        <div className="modal-overlay" onClick={() => setProposed(null)}>
          <div className="card modal-card" style={{ maxWidth: 720 }} onClick={(e) => e.stopPropagation()}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
              <h2 style={{ flex: 1, margin: 0 }}>AI 读稿推荐的智能体（勾选后采纳）</h2>
              <button className="btn btn-ghost btn-sm" onClick={() => setProposed(null)}>关闭</button>
            </div>
            {proposed.map((s, i) => (
              <div key={i} className="revision-item" style={{ alignItems: "flex-start" }}>
                <input type="checkbox" checked={picked.has(i)} style={{ marginTop: 5 }} onChange={(e) => {
                  const n = new Set(picked); if (e.target.checked) n.add(i); else n.delete(i); setPicked(n);
                }} />
                <div style={{ flex: 1 }}>
                  <div><strong>{s.name}</strong> <span className="badge badge-gray">{CATEGORY_LABEL[s.category] ?? s.category}</span></div>
                  <div className="muted small">{s.role}</div>
                  <div className="small" style={{ marginTop: 4, whiteSpace: "pre-wrap", color: "var(--ink-soft)" }}>{s.systemPrompt.slice(0, 220)}{s.systemPrompt.length > 220 ? "…" : ""}</div>
                </div>
              </div>
            ))}
            <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
              <button className="btn" onClick={adoptPicked}>采纳所选（{picked.size}）</button>
              <button className="btn btn-ghost" onClick={() => setProposed(null)}>取消</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
