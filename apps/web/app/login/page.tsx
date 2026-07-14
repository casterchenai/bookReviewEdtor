"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { api, setSession, type SessionUser } from "@/lib/api";

type AuthResponse = { token: string; user: SessionUser };

export default function LoginPage() {
  const router = useRouter();
  const [mode, setMode] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      const data = await api<AuthResponse>(`/auth/${mode}`, {
        method: "POST",
        body: mode === "login" ? { email, password } : { email, password, name },
      });
      setSession(data.token, data.user);
      router.push(data.user.isSuperAdmin ? "/admin" : "/dashboard");
    } catch (err) {
      setError(err instanceof Error ? err.message : "请求失败");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth-wrap">
      <div className="auth-card">
        <div className="logo">BookReviewEditor</div>
        <div className="slogan">主编 · 文学经纪人 · AI 智能助手 · 审校员 —— 协同打磨每一部书稿</div>
        <form onSubmit={submit}>
          {mode === "register" && (
            <div className="field">
              <label>姓名</label>
              <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="您的姓名" required />
            </div>
          )}
          <div className="field">
            <label>邮箱</label>
            <input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@example.com" required />
          </div>
          <div className="field">
            <label>密码</label>
            <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder={mode === "register" ? "至少 8 位" : "密码"} required />
          </div>
          {error && <div className="form-error">{error}</div>}
          <button className="btn" style={{ width: "100%", justifyContent: "center" }} disabled={busy}>
            {busy ? "请稍候…" : mode === "login" ? "登 录" : "注 册"}
          </button>
        </form>
        <div className="auth-switch">
          {mode === "login" ? (
            <>还没有账户？<a href="#" onClick={(e) => { e.preventDefault(); setMode("register"); setError(""); }}>立即注册</a></>
          ) : (
            <>已有账户？<a href="#" onClick={(e) => { e.preventDefault(); setMode("login"); setError(""); }}>返回登录</a></>
          )}
        </div>
        <div className="demo-tip">
          演示账户（密码均为 demo1234）：<br />
          主编 chief@demo.com · 经纪人 agent@demo.com · 审校员 reviewer@demo.com
        </div>
      </div>
    </div>
  );
}
