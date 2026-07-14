"use client";
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import TopBar from "@/components/TopBar";
import AiConfigForm from "@/components/AiConfigForm";
import { api, getUser } from "@/lib/api";

type AdminUser = {
  id: string; email: string; name: string; isSuperAdmin: boolean; canCreateBooks: boolean;
  createdAt: string; _count: { memberships: number; ownedProjects: number };
};

export default function AdminPage() {
  const router = useRouter();
  const [users, setUsers] = useState<AdminUser[] | null>(null);
  const [toast, setToast] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [canCreate, setCanCreate] = useState(true);
  const [editId, setEditId] = useState<string | null>(null);
  const [editPassword, setEditPassword] = useState("");

  const load = useCallback(() => {
    api<AdminUser[]>("/admin/users").then(setUsers).catch((e) => flash(e.message));
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

  async function toggleCreate(u: AdminUser) {
    try {
      await api(`/admin/users/${u.id}`, { method: "PATCH", body: { canCreateBooks: !u.canCreateBooks } });
      load(); flash(`已${u.canCreateBooks ? "取消" : "开通"} ${u.name} 的建书权限`);
    } catch (err) { flash(err instanceof Error ? err.message : "操作失败"); }
  }

  async function resetPassword(u: AdminUser) {
    if (!editPassword || editPassword.length < 8) { flash("新密码至少 8 位"); return; }
    try {
      await api(`/admin/users/${u.id}`, { method: "PATCH", body: { password: editPassword } });
      setEditId(null); setEditPassword(""); flash(`已重置 ${u.name} 的密码`);
    } catch (err) { flash(err instanceof Error ? err.message : "操作失败"); }
  }

  async function removeUser(u: AdminUser) {
    if (!confirm(`确认删除用户「${u.name}」？该用户在所有项目中的成员身份将一并移除，此操作不可撤销。`)) return;
    try {
      await api(`/admin/users/${u.id}`, { method: "DELETE" });
      load(); flash("用户已删除");
    } catch (err) { flash(err instanceof Error ? err.message : "删除失败"); }
  }

  return (
    <>
      <TopBar />
      <main className="container page">
        <div className="page-head">
          <div style={{ flex: 1 }}>
            <h1>超级管理员后台</h1>
            <div className="muted small">系统用户管理 · 全局 AI 模型配置</div>
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
                    <tr><th>用户</th><th>建书权限</th><th>参与/拥有</th><th style={{ textAlign: "right" }}>操作</th></tr>
                  </thead>
                  <tbody>
                    {users.map((u) => (
                      <tr key={u.id}>
                        <td>
                          <strong>{u.name}</strong>
                          {u.isSuperAdmin && <span className="badge badge-accent" style={{ marginLeft: 6 }}>超管</span>}
                          <div className="muted small">{u.email}</div>
                          {editId === u.id && (
                            <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
                              <input className="input" style={{ height: 30 }} type="text" placeholder="新密码 ≥8 位" value={editPassword} onChange={(e) => setEditPassword(e.target.value)} />
                              <button className="btn btn-sm" onClick={() => resetPassword(u)}>确定</button>
                              <button className="btn btn-ghost btn-sm" onClick={() => { setEditId(null); setEditPassword(""); }}>×</button>
                            </div>
                          )}
                        </td>
                        <td>
                          {u.isSuperAdmin ? <span className="muted small">全部</span> : (
                            <button className={`badge ${u.canCreateBooks ? "badge-ok" : "badge-gray"}`} style={{ cursor: "pointer", border: "none" }} onClick={() => toggleCreate(u)}>
                              {u.canCreateBooks ? "已开通" : "已禁用"}
                            </button>
                          )}
                        </td>
                        <td className="muted small">{u._count.memberships} / {u._count.ownedProjects}</td>
                        <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                          {!u.isSuperAdmin && (
                            <>
                              <button className="btn btn-ghost btn-sm" onClick={() => { setEditId(editId === u.id ? null : u.id); setEditPassword(""); }}>改密</button>
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
      </main>
      {toast && <div className="toast">{toast}</div>}
    </>
  );
}
