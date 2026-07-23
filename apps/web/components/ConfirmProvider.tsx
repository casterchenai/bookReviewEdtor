"use client";
// 应用内确认弹窗（替代原生 confirm，避免被浏览器/内置浏览器拦截）。
// 用法：const confirm = useConfirm(); if (!(await confirm({ body }))) return;
import { createContext, useCallback, useContext, useRef, useState } from "react";

type Opts = { title?: string; body: string; confirmText?: string; cancelText?: string; danger?: boolean };
const ConfirmCtx = createContext<(o: Opts) => Promise<boolean>>(async () => false);
export function useConfirm() { return useContext(ConfirmCtx); }

export default function ConfirmProvider({ children }: { children: React.ReactNode }) {
  const [opts, setOpts] = useState<Opts | null>(null);
  const resolver = useRef<((v: boolean) => void) | null>(null);

  const confirm = useCallback((o: Opts) => new Promise<boolean>((resolve) => {
    resolver.current = resolve;
    setOpts(o);
  }), []);

  function done(v: boolean) { setOpts(null); resolver.current?.(v); resolver.current = null; }

  return (
    <ConfirmCtx.Provider value={confirm}>
      {children}
      {opts && (
        <div className="modal-overlay" onClick={() => done(false)}>
          <div className="card modal-card" style={{ maxWidth: 440 }} onClick={(e) => e.stopPropagation()}>
            <h2 style={{ marginTop: 0 }}>{opts.title ?? "请确认"}</h2>
            <p className="muted small" style={{ whiteSpace: "pre-wrap" }}>{opts.body}</p>
            <div style={{ display: "flex", gap: 8 }}>
              <button className={`btn ${opts.danger ? "btn-danger" : ""}`} onClick={() => done(true)}>{opts.confirmText ?? "确认"}</button>
              <button className="btn btn-ghost" onClick={() => done(false)}>{opts.cancelText ?? "取消"}</button>
            </div>
          </div>
        </div>
      )}
    </ConfirmCtx.Provider>
  );
}
