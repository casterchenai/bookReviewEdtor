"use client";
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import TopBar from "@/components/TopBar";
import AiConfigForm from "@/components/AiConfigForm";
import { api, getUser } from "@/lib/api";

type AdminUser = {
  id: string; email: string; name: string; isSuperAdmin: boolean; canCreateBooks: boolean;
  isEnvAdmin: boolean; createdAt: string; _count: { memberships: number; ownedProjects: number };
};
type AdminProject = {
  id: string; title: string; description: string; createdAt: string;
  owner: { name: string; email: string }; _count: { manuscripts: number; members: number };
};

function roleOf(u: AdminUser) { return u.isSuperAdmin ? "super" : u.canCreateBooks ? "creator" : "normal"; }
const ROLE_LABELS: Record<string, string> = { super: "超级管理员", creator: "建书用户", normal: "普通用户" };

export default function AdminPage() {
  const router = useRouter();
  const [users, setUsers] = useState<AdminUser[] | null>(null);
  const [projects, setProjects] = useState<AdminProject[] | null>(null);
  const [toast, setToast] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [canCreate, setCanCreate] = useState(true);
  const [pwId, setPwId] = useState<string | null>(null);
  const [pwValue, setPwValue] = useState("");
  const [nameId, setNameId] = useState<string | null>(null);
  const [nameValue, setNameValue] = useState("");
  const [bookId, setBookId] = useState<string | null>(null);
  const [bookTitle, setBookTitle] = useState("");

  const load = useCallback(() => {
    api<AdminUser[]>("/admin/users").then(setUsers).catch((e) => flash(e.message));
    api<AdminProject[]>("/admin/projects").then(setProjects).catch(() => {});
  }, []);

  useEffect(() => {
    const u = getUser();
    if (!u?.isSuperAdmin) { router.replace("/dashboard"); return; }
    load();
  }, [load, router]);

  function flash(msg: string) { setToast(msg); setTimeout(() => setToast(""), 2800); }

  async function createUser(e: React.FormEvent) {
    e.preventDefault();
    try {
      await api("/admin/users", { method: "POST", body: { email, name, password, canCreateBooks: canCreate } });
      setEmail(""); setName(""); setPassword(""); setCanCreate(true); setShowCreate(false);
      load(); flash("用户已创建");
    } catch (err) { flash(err instanceof Error ? err.message : "创建失败"); }
  }

  async function changeRole(u: AdminUser, role: string) {
    const body = role === "super" ? { isSuperAdmin: true }
      : role === "creator" ? { isSuperAdmin: false, canCreateBooks: true }
      : { isSuperAdmin: false, canCreateBooks: false };
    try {
      await api(`/admin/users/${u.id}`, { method: "PATCH", body });
      load(); flash(`已将 ${u.name} 设为${ROLE_LABELS[role]}`);
    } catch (err) { flash(err instanceof Error ? err.message : "操作失败"); }
  }

  async function saveName(u: AdminUser) {
    if (!nameValue.trim()) { flash("姓名不能为空"); return; }
    try {
      await api(`/admin/users/${u.id}`, { method: "PATCH", body: { name: nameValue.trim() } });
      setNameId(null); setNameValue(""); load(); flash("姓名已更新");
    } catch (err) { flash(err instanceof Error ? err.message : "操作失败"); }
  }

  async function resetPassword(u: AdminUser) {
    if (!pwValue || pwValue.length < 8) { flash("新密码至少 8 位"); return; }
    try {
      await api(`/admin/users/${u.id}`, { method: "PATCH", body: { password: pwValue } });
      setPwId(null); setPwValue(""); flash(`已重置 ${u.name} 的密码`);
    } catch (err) { flash(err instanceof Error ? err.message : "操作失败"); }
  }

  async function removeUser(u: AdminUser) {
    if (!confirm(`确认删除用户「${u.name}」？该用户在所有项目中的成员身份将一并移除，不可撤销。`)) return;
    try { await api(`/admin/users/${u.id}`, { method: "DELETE" }); load(); flash("用户已删除"); }
    catch (err) { flash(err instanceof Error ? err.message : "删除失败"); }
  }

  async function renameBook(p: AdminProject) {
    if (!bookTitle.trim()) { flash("书名不能为空"); return; }
    try {
      await api(`/admin/projects/${p.id}`, { method: "PATCH", body: { title: bookTitle.trim() } });
      setBookId(null); setBookTitle(""); load(); flash("书名已更新");
    } catch (err) { flash(err instanceof Error ? err.message : "操作失败"); }
  }

  async function deleteBook(p: AdminProject) {
    if (!confirm(`确认删除书籍「${p.title}」？其全部 ${p._count.manuscripts} 篇书稿、成员、意见与修订历史将一并永久删除，不可撤销。`)) return;
    try { await api(`/admin/projects/${p.id}`, { method: "DELETE" }); load(); flash("书籍已删除"); }
    catch (err) { flash(err instanceof Error ? err.message : "删除失败"); }
  }

  return (
    <>
      <TopBar />
      <main className="container page">
        <div className="page-head">
          <div style={{ flex: 1 }}>
            <h1>超级管理员后台</h1>
            <div className="muted small">系统用户管理 · 书籍管理 · 全局 AI 模型配置</div>
          </div>
        </div>

        <div className="grid" style={{ gridTemplateColumns: "minmax(0,1fr) 360px", alignItems: "start" }}>
          {/* 用户管理 */}
          <div className="card">
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
              <h2 style={{ flex: 1, margin: 0 }}>系统用户</h2>
              <button className="btn btn-sm" onClick={() => setShowCreate((v) => !v)}>{showCreate ? "取消" : "＋ 新建用户"}</button>
            </div>

            {showCreate && (
              <form className="card" style={{ background: "var(--warn-tint)", marginBottom: 12 }} onSubmit={createUser}>
                <div className="field"><label>姓名</label><input className="input" value={name} onChange={(e) => setName(e.target.value)} required /></div>
                <div className="field"><label>邮箱</label><input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required /></div>
                <div className="field"><label>初始密码（≥8 位）</label><input className="input" type="text" value={password} onChange={(e) => setPassword(e.target.value)} required /></div>
                <label className="small" style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 10 }}>
                  <input type="checkbox" checked={canCreate} onChange={(e) => setCanCreate(e.target.checked)} /> 允许创建书稿项目
                </label>
                <button className="btn btn-sm">创建</button>
              </form>
            )}

            {users === null ? <div className="empty">加载中…</div> : users.length === 0 ? <div className="empty">暂无用户</div> : (
              <div style={{ overflowX: "auto" }}>
                <table className="admin-table">
                  <thead>
                    <tr><th>用户</th><th>角色</th><th>参与/拥有</th><th style={{ textAlign: "right" }}>操作</th></tr>
                  </thead>
                  <tbody>
                    {users.map((u) => (
                      <tr key={u.id}>
                        <td>
                          {nameId === u.id ? (
                            <div style={{ display: "flex", gap: 6 }}>
                              <input className="input" style={{ height: 30 }} value={nameValue} onChange={(e) => setNameValue(e.target.value)} />
                              <button className="btn btn-sm" onClick={() => saveName(u)}>✓</button>
                              <button className="btn btn-ghost btn-sm" onClick={() => setNameId(null)}>×</button>
                            </div>
                          ) : (
                            <div>
                              <strong>{u.name}</strong>
                              {!u.isEnvAdmin && <button className="linkbtn" onClick={() => { setNameId(u.id); setNameValue(u.name); }}>改名</button>}
                            </div>
                          )}
                          <div className="muted small">{u.email}</div>
                          {pwId === u.id && (
                            <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
                              <input className="input" style={{ height: 30 }} type="text" placeholder="新密码 ≥8 位" value={pwValue} onChange={(e) => setPwValue(e.target.value)} />
                              <button className="btn btn-sm" onClick={() => resetPassword(u)}>确定</button>
                              <button className="btn btn-ghost btn-sm" onClick={() => { setPwId(null); setPwValue(""); }}>×</button>
                            </div>
                          )}
                        </td>
                        <td>
                          {u.isEnvAdmin ? (
                            <span className="badge badge-accent">超级管理员·env</span>
                          ) : (
                            <select className="select" style={{ height: 30 }} value={roleOf(u)} onChange={(e) => changeRole(u, e.target.value)}>
                              <option value="normal">普通用户</option>
                              <option value="creator">建书用户</option>
                              <option value="super">超级管理员</option>
                            </select>
                          )}
                        </td>
                        <td className="muted small">{u._count.memberships} / {u._count.ownedProjects}</td>
                        <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                          {!u.isEnvAdmin && (
                            <>
                              <button className="btn btn-ghost btn-sm" onClick={() => { setPwId(pwId === u.id ? null : u.id); setPwValue(""); }}>改密</button>
                              <button className="btn btn-danger btn-sm" style={{ marginLeft: 6 }} onClick={() => removeUser(u)}>删除</button>
                            </>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* 全局 AI 配置 */}
          <div className="card">
            <h2>全局 AI 模型配置</h2>
            <div className="muted small" style={{ marginBottom: 10 }}>
              各书未单独配置时默认使用此设置。支持 OpenAI、智谱 GLM、DeepSeek、Anthropic 及 Auto 自动选择。
            </div>
            <AiConfigForm endpoint="/admin/ai-config" scope="global" onFlash={flash} />
          </div>
        </div>

        {/* 书籍管理 */}
        <div className="card" style={{ marginTop: 20 }}>
          <h2>书籍管理</h2>
          <div className="muted small" style={{ marginBottom: 10 }}>超级管理员可查看、重命名、删除系统中的任意书籍。</div>
          {projects === null ? <div className="empty">加载中…</div> : projects.length === 0 ? <div className="empty">暂无书籍</div> : (
            <div style={{ overflowX: "auto" }}>
              <table className="admin-table">
                <thead>
                  <tr><th>书名</th><th>拥有者</th><th>书稿/成员</th><th>创建时间</th><th style={{ textAlign: "right" }}>操作</th></tr>
                </thead>
                <tbody>
                  {projects.map((p) => (
                    <tr key={p.id}>
                      <td>
                        {bookId === p.id ? (
                          <div style={{ display: "flex", gap: 6 }}>
                            <input className="input" style={{ height: 30, minWidth: 220 }} value={bookTitle} onChange={(e) => setBookTitle(e.target.value)} />
                            <button className="btn btn-sm" onClick={() => renameBook(p)}>✓</button>
                            <button className="btn btn-ghost btn-sm" onClick={() => setBookId(null)}>×</button>
                          </div>
                        ) : (
                          <strong>{p.title}</strong>
                        )}
                      </td>
                      <td className="muted small">{p.owner.name}<br />{p.owner.email}</td>
                      <td className="muted small">{p._count.manuscripts} / {p._count.members}</td>
                      <td className="muted small">{new Date(p.createdAt).toLocaleDateString("zh-CN")}</td>
                      <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                        <button className="btn btn-ghost btn-sm" onClick={() => { setBookId(p.id); setBookTitle(p.title); }}>改名</button>
                        <button className="btn btn-danger btn-sm" style={{ marginLeft: 6 }} onClick={() => deleteBook(p)}>删除</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </main>
      {toast && <div className="toast">{toast}</div>}
    </>
  );
}
