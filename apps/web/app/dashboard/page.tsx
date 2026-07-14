"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import TopBar from "@/components/TopBar";
import { api, ROLE_LABEL } from "@/lib/api";

type ProjectRow = {
  id: string;
  title: string;
  description: string;
  manuscriptCount: number;
  memberCount: number;
  myRole: string;
  updatedAt: string;
};

export default function Dashboard() {
  const router = useRouter();
  const [projects, setProjects] = useState<ProjectRow[] | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    api<ProjectRow[]>("/projects").then(setProjects).catch(() => setProjects([]));
  }, []);

  async function createProject(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    try {
      const { id } = await api<{ id: string }>("/projects", { method: "POST", body: { title, description } });
      router.push(`/projects/${id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "创建失败");
    }
  }

  return (
    <>
      <TopBar />
      <main className="container page">
        <div className="page-head">
          <h1>我的书稿项目</h1>
          <button className="btn" onClick={() => setShowCreate((v) => !v)}>
            {showCreate ? "取消" : "＋ 新建项目"}
          </button>
        </div>

        {showCreate && (
          <form className="card" style={{ marginBottom: 20 }} onSubmit={createProject}>
            <div className="field">
              <label>书名 / 项目名称</label>
              <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="例如：《潮汐之间》出版前审校" required />
            </div>
            <div className="field">
              <label>项目简介（可选）</label>
              <textarea className="textarea" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="出版计划、当前审校阶段等" />
            </div>
            {error && <div className="form-error">{error}</div>}
            <button className="btn">创建项目</button>
            <span className="muted small" style={{ marginLeft: 12 }}>创建后您将担任主编，AI 智能助手自动加入</span>
          </form>
        )}

        {projects === null ? (
          <div className="empty">加载中…</div>
        ) : projects.length === 0 ? (
          <div className="empty">还没有项目。点击「新建项目」开始您的第一部书稿审校。</div>
        ) : (
          <div className="grid grid-2">
            {projects.map((p) => (
              <Link key={p.id} href={`/projects/${p.id}`} style={{ textDecoration: "none", color: "inherit" }}>
                <div className="card card-hover">
                  <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 8 }}>
                    <strong style={{ flex: 1, fontSize: "1.02rem" }}>{p.title}</strong>
                    <span className="badge">{ROLE_LABEL[p.myRole] ?? p.myRole}</span>
                  </div>
                  <div className="muted small" style={{ minHeight: 40 }}>
                    {p.description || "（暂无简介）"}
                  </div>
                  <div className="muted small" style={{ marginTop: 10 }}>
                    书稿 {p.manuscriptCount} 篇 · 成员 {p.memberCount} 人 · 更新于 {new Date(p.updatedAt).toLocaleDateString("zh-CN")}
                  </div>
                </div>
              </Link>
            ))}
          </div>
        )}
      </main>
    </>
  );
}
