"use client";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import TopBar from "@/components/TopBar";
import { api, ROLE_LABEL, STATUS_LABEL } from "@/lib/api";

type ProjectDetail = {
  id: string;
  title: string;
  description: string;
  standards: string;
  myRole: string;
  members: { id: string; role: string; user: { id: string; name: string; email: string; isAI: boolean } }[];
  manuscripts: {
    id: string; title: string; status: string; updatedAt: string;
    _count: { revisions: number; comments: number };
  }[];
  activities: { id: string; actorName: string; action: string; detail: string; createdAt: string }[];
};

export default function ProjectPage() {
  const { id } = useParams<{ id: string }>();
  const [project, setProject] = useState<ProjectDetail | null>(null);
  const [error, setError] = useState("");
  const [newTitle, setNewTitle] = useState("");
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState("REVIEWER");
  const [standards, setStandards] = useState("");
  const [editingStandards, setEditingStandards] = useState(false);
  const [toast, setToast] = useState("");

  const load = useCallback(() => {
    api<ProjectDetail>(`/projects/${id}`)
      .then((p) => { setProject(p); setStandards(p.standards); })
      .catch((e) => setError(e.message));
  }, [id]);
  useEffect(load, [load]);

  function flash(msg: string) {
    setToast(msg);
    setTimeout(() => setToast(""), 2500);
  }

  if (error) return (<><TopBar /><main className="container page"><div className="empty">{error}</div></main></>);
  if (!project) return (<><TopBar /><main className="container page"><div className="empty">加载中…</div></main></>);

  const isChief = project.myRole === "CHIEF_EDITOR";

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
          <span className="badge">我的角色：{ROLE_LABEL[project.myRole]}</span>
        </div>

        <div className="grid" style={{ gridTemplateColumns: "minmax(0,1fr) 340px", alignItems: "start" }}>
          <div>
            {/* 书稿列表 */}
            <div className="card">
              <h2>书稿章节</h2>
              {project.manuscripts.length === 0 && <div className="empty">暂无书稿，请先新建章节。</div>}
              {project.manuscripts.map((m) => (
                <Link key={m.id} href={`/manuscripts/${m.id}`} style={{ textDecoration: "none", color: "inherit" }}>
                  <div className="revision-item" style={{ cursor: "pointer", alignItems: "center" }}>
                    <div style={{ flex: 1 }}>
                      <strong>{m.title}</strong>
                      <div className="muted small">
                        修订 {m._count.revisions} 次 · 待处理意见 {m._count.comments} 条 · 更新于 {new Date(m.updatedAt).toLocaleString("zh-CN")}
                      </div>
                    </div>
                    <span className={`badge ${m.status === "FINALIZED" ? "badge-ok" : m.status === "IN_REVIEW" ? "badge-warn" : "badge-gray"}`}>
                      {STATUS_LABEL[m.status]}
                    </span>
                  </div>
                </Link>
              ))}
              {project.myRole !== "AI_ASSISTANT" && (
                <form
                  style={{ display: "flex", gap: 8, marginTop: 14 }}
                  onSubmit={async (e) => {
                    e.preventDefault();
                    try {
                      await api(`/projects/${id}/manuscripts`, { method: "POST", body: { title: newTitle } });
                      setNewTitle("");
                      load();
                      flash("章节已创建");
                    } catch (err) { flash(err instanceof Error ? err.message : "创建失败"); }
                  }}
                >
                  <input className="input" style={{ flex: 1 }} placeholder="新章节标题，例如：第二章 旧信" value={newTitle} onChange={(e) => setNewTitle(e.target.value)} required />
                  <button className="btn">新建书稿</button>
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
                    <button
                      className="btn btn-sm"
                      onClick={async () => {
                        try {
                          await api(`/projects/${id}`, { method: "PATCH", body: { standards } });
                          setEditingStandards(false);
                          load();
                          flash("修订标准已更新，AI 审校将遵循新标准");
                        } catch (err) { flash(err instanceof Error ? err.message : "保存失败"); }
                      }}
                    >保存</button>
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

          {/* 成员 */}
          <div className="card">
            <h2>项目成员</h2>
            {project.members.map((m) => (
              <div key={m.id} className="revision-item" style={{ alignItems: "center" }}>
                <div style={{ flex: 1 }}>
                  <strong>{m.user.name}</strong>
                  {!m.user.isAI && <div className="muted small">{m.user.email}</div>}
                </div>
                <span className={`badge ${m.role === "AI_ASSISTANT" ? "" : m.role === "CHIEF_EDITOR" ? "badge-accent" : "badge-gray"}`}>
                  {ROLE_LABEL[m.role]}
                </span>
              </div>
            ))}
            {isChief && (
              <form
                style={{ marginTop: 14 }}
                onSubmit={async (e) => {
                  e.preventDefault();
                  try {
                    await api(`/projects/${id}/members`, { method: "POST", body: { email: inviteEmail, role: inviteRole } });
                    setInviteEmail("");
                    load();
                    flash("成员已添加");
                  } catch (err) { flash(err instanceof Error ? err.message : "添加失败"); }
                }}
              >
                <div className="field" style={{ marginBottom: 8 }}>
                  <input className="input" type="email" placeholder="成员注册邮箱" value={inviteEmail} onChange={(e) => setInviteEmail(e.target.value)} required />
                </div>
                <div style={{ display: "flex", gap: 8 }}>
                  <select className="select" style={{ flex: 1 }} value={inviteRole} onChange={(e) => setInviteRole(e.target.value)}>
                    <option value="REVIEWER">审校员</option>
                    <option value="AGENT">文学经纪人</option>
                    <option value="CHIEF_EDITOR">主编</option>
                  </select>
                  <button className="btn btn-sm">添加成员</button>
                </div>
              </form>
            )}
          </div>
        </div>
      </main>
      {toast && <div className="toast">{toast}</div>}
    </>
  );
}
