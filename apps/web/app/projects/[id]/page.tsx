"use client";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import TopBar from "@/components/TopBar";
import AiConfigForm from "@/components/AiConfigForm";
import AgentManager from "@/components/AgentManager";
import { useConfirm } from "@/components/ConfirmProvider";
import ReferenceLibrary from "@/components/ReferenceLibrary";
import { api, downloadFile, ROLE_LABEL, STATUS_LABEL } from "@/lib/api";

type BookRole = { id: string; name: string; base: string; order?: number; isDefault?: boolean; _count?: { members: number } };
type Member = {
  id: string; role: string; bookRole: { id: string; name: string; base: string } | null;
  user: { id: string; name: string; email: string; isAI: boolean };
};
type ProjectDetail = {
  id: string; title: string; description: string; standards: string; myRole: string;
  members: Member[];
  bookRoles: BookRole[];
  hasBookAiConfig: boolean;
  manuscripts: { id: string; title: string; status: string; section: string; updatedAt: string; _count: { revisions: number; comments: number } }[];
  activities: { id: string; actorName: string; action: string; detail: string; createdAt: string }[];
};

function groupBySection<T extends { section: string }>(items: T[]): [string, T[]][] {
  const groups: [string, T[]][] = [];
  const idx = new Map<string, number>();
  for (const it of items) {
    const key = it.section || "";
    if (!idx.has(key)) { idx.set(key, groups.length); groups.push([key, []]); }
    groups[idx.get(key)!][1].push(it);
  }
  return groups;
}

const BASE_LABEL: Record<string, string> = { CHIEF_EDITOR: "主编（管理权）", AGENT: "内容顾问（编辑+建议）", REVIEWER: "审校员（编辑+建议）", AI_ASSISTANT: "AI 助手" };
const BASE_OPTIONS = [
  { value: "REVIEWER", label: "审校员（可编辑内容、提交意见）" },
  { value: "AGENT", label: "内容顾问（可编辑内容、提交意见）" },
  { value: "CHIEF_EDITOR", label: "主编（管理成员/角色/定稿）" },
];

export default function ProjectPage() {
  const { id } = useParams<{ id: string }>();
  const confirm = useConfirm();
  const [project, setProject] = useState<ProjectDetail | null>(null);
  const [error, setError] = useState("");
  const [newTitle, setNewTitle] = useState("");
  const [renameId, setRenameId] = useState<string | null>(null);
  const [renameVal, setRenameVal] = useState("");
  const [bookSearch, setBookSearch] = useState("");
  const [searchResults, setSearchResults] = useState<{ id: string; title: string; section: string; count: number; snippet: string }[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRoleId, setInviteRoleId] = useState("");
  const [standards, setStandards] = useState("");
  const [editingStandards, setEditingStandards] = useState(false);
  const [manageRoles, setManageRoles] = useState(false);
  const [newRoleName, setNewRoleName] = useState("");
  const [newRoleBase, setNewRoleBase] = useState("REVIEWER");
  const [showAi, setShowAi] = useState(false);
  const [batch, setBatch] = useState<{ done: number; total: number } | null>(null);
  const [toast, setToast] = useState("");

  const load = useCallback(() => {
    api<ProjectDetail>(`/projects/${id}`)
      .then((p) => {
        setProject(p);
        setStandards(p.standards);
        const assignable = p.bookRoles.filter((r) => r.base !== "AI_ASSISTANT");
        setInviteRoleId((cur) => cur || assignable.find((r) => r.base === "REVIEWER")?.id || assignable[0]?.id || "");
      })
      .catch((e) => setError(e.message));
  }, [id]);
  useEffect(load, [load]);

  function flash(msg: string) { setToast(msg); setTimeout(() => setToast(""), 2500); }

  if (error) return (<><TopBar /><main className="container page"><div className="empty">{error}</div></main></>);
  if (!project) return (<><TopBar /><main className="container page"><div className="empty">加载中…</div></main></>);

  const isChief = project.myRole === "CHIEF_EDITOR";
  const assignableRoles = project.bookRoles.filter((r) => r.base !== "AI_ASSISTANT");

  async function batchReview() {
    if (!project) return;
    const targets = project.manuscripts.filter((m) => m.status !== "FINALIZED");
    if (targets.length === 0) { flash("没有可审校的书稿"); return; }
    if (!(await confirm({ title: "批量 AI 审校", body: `将对 ${targets.length} 篇未定稿书稿依次运行 AI 智能审校，可能需要几分钟。继续？`, confirmText: "开始" }))) return;
    setBatch({ done: 0, total: targets.length });
    let ok = 0;
    for (let i = 0; i < targets.length; i++) {
      try { await api(`/ai/manuscripts/${targets[i].id}/review`, { method: "POST" }); ok++; }
      catch { /* 单章失败继续 */ }
      setBatch({ done: i + 1, total: targets.length });
    }
    setBatch(null); load();
    flash(`批量审校完成：${ok}/${targets.length} 篇已生成 AI 意见`);
  }

  function uploadKind(name: string) {
    return /\.(md|markdown)$/i.test(name) ? "Markdown"
      : /\.(html?|htm)$/i.test(name) ? "HTML"
      : /\.pdf$/i.test(name) ? "PDF" : "文本";
  }

  function fileToBase64(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result).split(",")[1] ?? "");
      r.onerror = () => reject(new Error("读取文件失败"));
      r.readAsDataURL(file);
    });
  }

  async function runSearch(e: React.FormEvent) {
    e.preventDefault();
    const q = bookSearch.trim();
    if (!q) { setSearchResults(null); return; }
    setSearching(true);
    try {
      const r = await api<{ results: typeof searchResults }>(`/projects/${id}/search?q=${encodeURIComponent(q)}`);
      setSearchResults(r.results ?? []);
    } catch (err) { flash(err instanceof Error ? err.message : "搜索失败"); }
    finally { setSearching(false); }
  }

  async function renameChapter(mid: string) {
    if (!renameVal.trim()) { flash("标题不能为空"); return; }
    try {
      await api(`/manuscripts/${mid}/title`, { method: "PATCH", body: { title: renameVal.trim() } });
      setRenameId(null); load(); flash("章节已改名");
    } catch (err) { flash(err instanceof Error ? err.message : "改名失败"); }
  }

  async function createChapter(e: React.FormEvent) {
    e.preventDefault();
    try {
      let body: Record<string, unknown> = { title: newTitle };
      if (uploadFile) {
        const name = uploadFile.name;
        if (/\.pdf$/i.test(name)) {
          body = { title: newTitle, sourceType: "pdf", source: await fileToBase64(uploadFile) };
        } else {
          const sourceType = /\.(md|markdown)$/i.test(name) ? "md" : /\.(html?|htm)$/i.test(name) ? "html" : "text";
          body = { title: newTitle, sourceType, source: await uploadFile.text() };
        }
      }
      await api(`/projects/${id}/manuscripts`, { method: "POST", body });
      setNewTitle(""); setUploadFile(null); load();
      flash(uploadFile ? "已上传并解析为书稿" : "章节已创建");
    } catch (err) { flash(err instanceof Error ? err.message : "创建失败"); }
  }

  async function addMember(e: React.FormEvent) {
    e.preventDefault();
    try {
      await api(`/projects/${id}/members`, { method: "POST", body: { email: inviteEmail, bookRoleId: inviteRoleId } });
      setInviteEmail(""); load(); flash("成员已添加");
    } catch (err) { flash(err instanceof Error ? err.message : "添加失败"); }
  }

  async function changeMemberRole(memberId: string, bookRoleId: string) {
    try {
      await api(`/projects/${id}/members/${memberId}`, { method: "PATCH", body: { bookRoleId } });
      load(); flash("角色已更新");
    } catch (err) { flash(err instanceof Error ? err.message : "更新失败"); }
  }

  async function removeMember(memberId: string, name: string) {
    if (!(await confirm({ title: "移除成员", body: `确认将「${name}」移出本项目？`, confirmText: "移除", danger: true }))) return;
    try {
      await api(`/projects/${id}/members/${memberId}`, { method: "DELETE" });
      load(); flash("成员已移除");
    } catch (err) { flash(err instanceof Error ? err.message : "移除失败"); }
  }

  async function addRole(e: React.FormEvent) {
    e.preventDefault();
    try {
      await api(`/projects/${id}/roles`, { method: "POST", body: { name: newRoleName, base: newRoleBase } });
      setNewRoleName(""); load(); flash("角色已新建");
    } catch (err) { flash(err instanceof Error ? err.message : "新建失败"); }
  }

  async function renameRole(roleId: string, name: string) {
    try {
      await api(`/projects/${id}/roles/${roleId}`, { method: "PATCH", body: { name } });
      load(); flash("角色名已更新");
    } catch (err) { flash(err instanceof Error ? err.message : "更新失败"); }
  }

  async function deleteRole(roleId: string) {
    if (!(await confirm({ title: "删除角色", body: "确认删除该角色？", confirmText: "删除", danger: true }))) return;
    try {
      await api(`/projects/${id}/roles/${roleId}`, { method: "DELETE" });
      load(); flash("角色已删除");
    } catch (err) { flash(err instanceof Error ? err.message : "删除失败"); }
  }

  return (
    <>
      <TopBar />
      <main className="container page">
        <div className="page-head">
          <div style={{ flex: 1 }}>
            <div className="muted small"><Link href="/dashboard">项目列表</Link> / 项目详情</div>
            <h1>{project.title}</h1>
            {project.description && <div className="muted" style={{ marginTop: 4 }}>{project.description}</div>}
          </div>
          <span className="badge">我的角色：{project.members.find((m) => m.role === project.myRole && !m.user.isAI)?.bookRole?.name ?? ROLE_LABEL[project.myRole]}</span>
        </div>

        {/* 全书搜索 */}
        <form className="book-search" onSubmit={runSearch}>
          <input className="input" placeholder="全书搜索关键词，快速定位到章节…" value={bookSearch}
            onChange={(e) => setBookSearch(e.target.value)} />
          <button className="btn btn-sm" disabled={searching}>{searching ? "搜索中…" : "搜索"}</button>
          {searchResults !== null && <button type="button" className="btn btn-ghost btn-sm" onClick={() => { setSearchResults(null); setBookSearch(""); }}>清除</button>}
        </form>
        {searchResults !== null && (
          <div className="card" style={{ marginBottom: 16 }}>
            <div className="muted small" style={{ marginBottom: 6 }}>
              「{bookSearch}」命中 {searchResults.length} 个章节（共 {searchResults.reduce((s, r) => s + r.count, 0)} 处）
            </div>
            {searchResults.length === 0 ? <div className="empty small">未找到匹配</div> : searchResults.map((r) => (
              <Link key={r.id} href={`/manuscripts/${r.id}?q=${encodeURIComponent(bookSearch)}`} style={{ textDecoration: "none", color: "inherit" }}>
                <div className="revision-item" style={{ cursor: "pointer" }}>
                  <div style={{ flex: 1 }}>
                    <strong>{r.section ? r.section + " / " : ""}{r.title}</strong> <span className="badge badge-gray">{r.count} 处</span>
                    <div className="muted small" style={{ marginTop: 2 }}>{r.snippet}</div>
                  </div>
                </div>
              </Link>
            ))}
          </div>
        )}

        <div className="grid" style={{ gridTemplateColumns: "minmax(0,1fr) 340px", alignItems: "start" }}>
          <div>
            {/* 书稿列表 */}
            <div className="card">
              <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                <h2 style={{ flex: 1, margin: 0 }}>书稿章节（{project.manuscripts.length}）</h2>
                {project.manuscripts.length > 0 && (
                  <>
                    <button className="btn btn-ghost btn-sm" onClick={() => downloadFile(`/projects/${id}/export?format=docx`).catch((e) => flash(e.message))}>导出整书 Word</button>
                    <button className="btn btn-ghost btn-sm" onClick={() => downloadFile(`/projects/${id}/export?format=md`).catch((e) => flash(e.message))}>导出整书 MD</button>
                    <button className="btn btn-ghost btn-sm" onClick={() => downloadFile(`/projects/${id}/export?format=html`).catch((e) => flash(e.message))}>导出整书 HTML</button>
                    {project.myRole !== "AI_ASSISTANT" && (
                      <button className="btn btn-sm" disabled={!!batch} onClick={batchReview}>
                        {batch ? `AI 审校中 ${batch.done}/${batch.total}` : "🤖 批量 AI 审校"}
                      </button>
                    )}
                  </>
                )}
              </div>
              {project.manuscripts.length > 0 && (() => {
                const total = project.manuscripts.length;
                const fin = project.manuscripts.filter((m) => m.status === "FINALIZED").length;
                const open = project.manuscripts.reduce((s, m) => s + m._count.comments, 0);
                const pct = Math.round((fin / total) * 100);
                return (
                  <div className="progress-box">
                    <div className="progress-stats">
                      <span>定稿 <strong>{fin}</strong>/{total}</span>
                      <span>待处理意见 <strong>{open}</strong> 条</span>
                      <span>{pct}% 完成</span>
                    </div>
                    <div className="progress-bar"><div className="progress-fill" style={{ width: `${pct}%` }} /></div>
                  </div>
                );
              })()}
              {project.manuscripts.length === 0 && <div className="empty">暂无书稿，请先新建章节。</div>}
              {groupBySection(project.manuscripts).map(([section, items]) => (
                <div key={section}>
                  {section && <div className="section-head">{section}</div>}
                  {items.map((m) => renameId === m.id ? (
                    <div key={m.id} className="revision-item" style={{ alignItems: "center", gap: 8 }}>
                      <input className="input" style={{ flex: 1 }} value={renameVal} autoFocus onChange={(e) => setRenameVal(e.target.value)}
                        onKeyDown={(e) => { if (e.key === "Enter") renameChapter(m.id); if (e.key === "Escape") setRenameId(null); }} />
                      <button className="btn btn-sm" onClick={() => renameChapter(m.id)}>保存</button>
                      <button className="btn btn-ghost btn-sm" onClick={() => setRenameId(null)}>取消</button>
                    </div>
                  ) : (
                    <div key={m.id} className="revision-item" style={{ alignItems: "center" }}>
                      <Link href={`/manuscripts/${m.id}`} style={{ textDecoration: "none", color: "inherit", flex: 1 }}>
                        <div style={{ cursor: "pointer" }}>
                          <strong>{m.title}</strong>
                          <div className="muted small">
                            修订 {m._count.revisions} 次 · 待处理意见 {m._count.comments} 条 · 更新于 {new Date(m.updatedAt).toLocaleString("zh-CN")}
                          </div>
                        </div>
                      </Link>
                      {isChief && m.status !== "FINALIZED" && (
                        <button className="btn btn-ghost btn-sm" onClick={() => { setRenameId(m.id); setRenameVal(m.title); }}>改名</button>
                      )}
                      <span className={`badge ${m.status === "FINALIZED" ? "badge-ok" : m.status === "IN_REVIEW" ? "badge-warn" : "badge-gray"}`}>
                        {STATUS_LABEL[m.status]}
                      </span>
                    </div>
                  ))}
                </div>
              ))}
              {project.myRole !== "AI_ASSISTANT" && (
                <form style={{ marginTop: 14 }} onSubmit={createChapter}>
                  <div style={{ display: "flex", gap: 8 }}>
                    <input className="input" style={{ flex: 1 }} placeholder="新章节标题，例如：第二章 旧信" value={newTitle} onChange={(e) => setNewTitle(e.target.value)} required />
                    <button className="btn">{uploadFile ? "上传并解析" : "新建书稿"}</button>
                  </div>
                  <label className="upload-drop" style={{ display: "block", marginTop: 8 }}>
                    {uploadFile ? `已选择：${uploadFile.name}（${uploadKind(uploadFile.name)}）` : "可选：上传 HTML / Markdown / PDF 文件，自动解析为可审校内容（PDF 逐页分文本页/图册页）"}
                    <input
                      type="file" accept=".html,.htm,.md,.markdown,.txt,.pdf" style={{ display: "none" }}
                      onChange={(e) => {
                        const f = e.target.files?.[0] ?? null;
                        setUploadFile(f);
                        if (f && !newTitle.trim()) setNewTitle(f.name.replace(/\.[^.]+$/, ""));
                      }}
                    />
                  </label>
                  {uploadFile && <button type="button" className="btn btn-ghost btn-sm" style={{ marginTop: 6 }} onClick={() => setUploadFile(null)}>清除文件</button>}
                </form>
              )}
            </div>

            {/* 修订标准 */}
            <div className="card">
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <h2 style={{ flex: 1, margin: 0 }}>修订标准（主编制定）</h2>
                {isChief && !editingStandards && (
                  <button className="btn btn-ghost btn-sm" onClick={() => setEditingStandards(true)}>编辑</button>
                )}
              </div>
              {editingStandards ? (
                <div style={{ marginTop: 10 }}>
                  <textarea className="textarea" rows={6} value={standards} onChange={(e) => setStandards(e.target.value)} />
                  <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                    <button className="btn btn-sm" onClick={async () => {
                      try {
                        await api(`/projects/${id}`, { method: "PATCH", body: { standards } });
                        setEditingStandards(false); load(); flash("修订标准已更新，AI 审校将遵循新标准");
                      } catch (err) { flash(err instanceof Error ? err.message : "保存失败"); }
                    }}>保存</button>
                    <button className="btn btn-ghost btn-sm" onClick={() => { setEditingStandards(false); setStandards(project.standards); }}>取消</button>
                  </div>
                </div>
              ) : (
                <div style={{ whiteSpace: "pre-wrap", marginTop: 8, fontSize: "0.9rem" }} className={project.standards ? "" : "muted"}>
                  {project.standards || "（尚未制定。修订标准会同时作为 AI 审校的依据。）"}
                </div>
              )}
            </div>

            {/* 操作日志 */}
            <div className="card">
              <h2>操作日志</h2>
              {project.activities.length === 0 && <div className="muted small">暂无记录</div>}
              {project.activities.map((a) => (
                <div key={a.id} className="activity-item">
                  <span className="time">{new Date(a.createdAt).toLocaleString("zh-CN")}</span>
                  <span><strong>{a.actorName}</strong> {a.action}{a.detail ? `：${a.detail}` : ""}</span>
                </div>
              ))}
            </div>
          </div>

          <div>
            {/* 成员 */}
            <div className="card">
              <h2>项目成员</h2>
              {project.members.map((m) => (
                <div key={m.id} className="revision-item" style={{ alignItems: "center" }}>
                  <div style={{ flex: 1 }}>
                    <strong>{m.user.name}</strong>
                    {!m.user.isAI && <div className="muted small">{m.user.email}</div>}
                    {isChief && !m.user.isAI && (
                      <select
                        className="select" style={{ height: 30, marginTop: 4 }}
                        value={m.bookRole?.id ?? ""}
                        onChange={(e) => changeMemberRole(m.id, e.target.value)}
                      >
                        {assignableRoles.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
                      </select>
                    )}
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 4, alignItems: "flex-end" }}>
                    <span className={`badge ${m.role === "AI_ASSISTANT" ? "" : m.role === "CHIEF_EDITOR" ? "badge-accent" : "badge-gray"}`}>
                      {m.bookRole?.name ?? ROLE_LABEL[m.role]}
                    </span>
                    {isChief && !m.user.isAI && m.user.id !== project.members.find((x) => x.role === "CHIEF_EDITOR")?.user.id && (
                      <button className="btn btn-danger btn-sm" onClick={() => removeMember(m.id, m.user.name)}>移除</button>
                    )}
                  </div>
                </div>
              ))}
              {isChief && (
                <form style={{ marginTop: 14 }} onSubmit={addMember}>
                  <div className="field" style={{ marginBottom: 8 }}>
                    <input className="input" type="email" placeholder="成员注册邮箱" value={inviteEmail} onChange={(e) => setInviteEmail(e.target.value)} required />
                  </div>
                  <div style={{ display: "flex", gap: 8 }}>
                    <select className="select" style={{ flex: 1 }} value={inviteRoleId} onChange={(e) => setInviteRoleId(e.target.value)}>
                      {assignableRoles.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
                    </select>
                    <button className="btn btn-sm">添加成员</button>
                  </div>
                </form>
              )}
            </div>

            {/* 本书角色管理 */}
            {isChief && (
              <div className="card">
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <h2 style={{ flex: 1, margin: 0 }}>角色配置</h2>
                  <button className="btn btn-ghost btn-sm" onClick={() => setManageRoles((v) => !v)}>{manageRoles ? "收起" : "管理"}</button>
                </div>
                <div className="muted small" style={{ marginTop: 4 }}>本书的角色名称可自定义，权限由能力原型决定。</div>
                {manageRoles && (
                  <div style={{ marginTop: 10 }}>
                    {project.bookRoles.map((r) => (
                      <div key={r.id} className="revision-item" style={{ alignItems: "center" }}>
                        <div style={{ flex: 1 }}>
                          {r.base === "AI_ASSISTANT" ? (
                            <strong>{r.name}</strong>
                          ) : (
                            <input
                              className="input" style={{ height: 30 }} defaultValue={r.name}
                              onBlur={(e) => { if (e.target.value.trim() && e.target.value !== r.name) renameRole(r.id, e.target.value.trim()); }}
                            />
                          )}
                          <div className="muted small">{BASE_LABEL[r.base]} · {r._count?.members ?? 0} 人</div>
                        </div>
                        {r.base !== "AI_ASSISTANT" && !(r.base === "CHIEF_EDITOR" && r.isDefault) && (r._count?.members ?? 0) === 0 && (
                          <button className="btn btn-danger btn-sm" onClick={() => deleteRole(r.id)}>删除</button>
                        )}
                      </div>
                    ))}
                    <form style={{ marginTop: 10 }} onSubmit={addRole}>
                      <div className="field" style={{ marginBottom: 8 }}>
                        <input className="input" placeholder="新角色名，如「特邀审校」" value={newRoleName} onChange={(e) => setNewRoleName(e.target.value)} required />
                      </div>
                      <div style={{ display: "flex", gap: 8 }}>
                        <select className="select" style={{ flex: 1 }} value={newRoleBase} onChange={(e) => setNewRoleBase(e.target.value)}>
                          {BASE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                        </select>
                        <button className="btn btn-sm">新建角色</button>
                      </div>
                    </form>
                  </div>
                )}
              </div>
            )}

            {/* 本书 AI 配置 */}
            {isChief && (
              <div className="card">
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <h2 style={{ flex: 1, margin: 0 }}>本书 AI 配置</h2>
                  <button className="btn btn-ghost btn-sm" onClick={() => setShowAi((v) => !v)}>{showAi ? "收起" : project.hasBookAiConfig ? "已配置" : "设置"}</button>
                </div>
                {showAi && <div style={{ marginTop: 10 }}><AiConfigForm endpoint={`/projects/${id}/ai-config`} scope="book" onFlash={flash} /></div>}
              </div>
            )}

            {/* 本书参考文献 / 资料 */}
            {isChief && <ReferenceLibrary projectId={id} onFlash={flash} />}

            {/* 本书 AI 审校智能体 */}
            {isChief && <AgentManager projectId={id} onFlash={flash} />}
          </div>
        </div>
      </main>
      {toast && <div className="toast">{toast}</div>}
    </>
  );
}
