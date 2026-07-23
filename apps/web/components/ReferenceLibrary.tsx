"use client";
// 每本书的参考文献 / 资料：上传多份（WPS/Office/PDF/图片）、列表、下载、删除
import { useCallback, useEffect, useState } from "react";
import { api, downloadFile } from "@/lib/api";

type Ref = {
  id: string; name: string; kind: string; size: number; createdAt: string;
  hasText: boolean; textChars: number; downloadable: boolean;
};

const ICON: Record<string, string> = { pdf: "📄", word: "📝", sheet: "📊", slide: "📽", image: "🖼", other: "📎" };
const ACCEPT = ".pdf,.doc,.docx,.wps,.xls,.xlsx,.et,.csv,.ods,.ppt,.pptx,.dps,.png,.jpg,.jpeg,.gif,.webp";

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1] ?? "");
    r.onerror = () => reject(new Error("读取文件失败"));
    r.readAsDataURL(file);
  });
}

export default function ReferenceLibrary({ projectId, onFlash }: { projectId: string; onFlash: (m: string) => void }) {
  const [open, setOpen] = useState(false);
  const [refs, setRefs] = useState<Ref[] | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api<Ref[]>(`/projects/${projectId}/references`).then(setRefs).catch(() => setRefs([]));
  }, [projectId]);
  useEffect(() => { if (open) load(); }, [open, load]);

  async function upload(files: FileList | null) {
    if (!files || files.length === 0) return;
    setBusy(true);
    let ok = 0;
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      onFlash(`上传中 ${i + 1}/${files.length}：${f.name}…`);
      try {
        if (f.size > 25 * 1024 * 1024) { onFlash(`${f.name} 超过 25MB，已跳过`); continue; }
        const dataBase64 = await fileToBase64(f);
        await api(`/projects/${projectId}/references`, { method: "POST", body: { name: f.name, mime: f.type, dataBase64 } });
        ok++;
      } catch (err) { onFlash(`${f.name} 上传失败：${err instanceof Error ? err.message : ""}`); }
    }
    setBusy(false); load();
    onFlash(`已上传 ${ok}/${files.length} 份参考文献`);
  }

  async function remove(r: Ref) {
    if (!confirm(`删除参考文献「${r.name}」？`)) return;
    try { await api(`/projects/${projectId}/references/${r.id}`, { method: "DELETE" }); load(); onFlash("已删除"); }
    catch (err) { onFlash(err instanceof Error ? err.message : "删除失败"); }
  }

  const kb = (n: number) => n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;

  return (
    <div className="card">
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <h2 style={{ flex: 1, margin: 0 }}>参考文献 / 资料{refs && refs.length > 0 ? `（${refs.length}）` : ""}</h2>
        <button className="btn btn-ghost btn-sm" onClick={() => setOpen((v) => !v)}>{open ? "收起" : "管理"}</button>
      </div>
      <div className="muted small" style={{ marginTop: 4 }}>上传法规/标准/范本等资料，AI 会据此设计智能体，并在审校时核对原文是否与之一致。</div>

      {open && (
        <div style={{ marginTop: 10 }}>
          <label className="upload-drop" style={{ display: "block", marginBottom: 10 }}>
            {busy ? "上传中…" : "点击选择文件上传（可多选）· 支持 PDF / Word / Excel / PPT / WPS / 图片"}
            <input type="file" multiple accept={ACCEPT} style={{ display: "none" }} disabled={busy}
              onChange={(e) => { upload(e.target.files); e.target.value = ""; }} />
          </label>

          {refs === null ? <div className="empty small">加载中…</div> : refs.length === 0 ? (
            <div className="muted small">还没有参考文献。上传后，去「AI 审校智能体」点「AI 读稿推荐」，AI 会结合这些资料设计智能体。</div>
          ) : refs.map((r) => (
            <div key={r.id} className="revision-item" style={{ alignItems: "center" }}>
              <div style={{ flex: 1 }}>
                <strong>{ICON[r.kind] ?? "📎"} {r.name}</strong>
                <div className="muted small">
                  {kb(r.size)} · {r.hasText ? `已提取 ${r.textChars} 字供 AI 阅读` : (r.kind === "image" ? "图片（未提取文字）" : "未能提取文字")}
                </div>
              </div>
              {r.downloadable && (
                <button className="btn btn-ghost btn-sm" onClick={() => downloadFile(`/projects/${projectId}/references/${r.id}/download`).catch((e) => onFlash(e.message))}>下载</button>
              )}
              <button className="btn btn-danger btn-sm" onClick={() => remove(r)}>删除</button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
