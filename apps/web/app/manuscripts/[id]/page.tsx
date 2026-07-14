"use client";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { diffChars } from "diff";
import TopBar from "@/components/TopBar";
import { api, downloadFile, CATEGORY_LABEL, ROLE_LABEL, STATUS_LABEL } from "@/lib/api";
import { RichDocView, RichDocEditor, parseDoc, blockPreview, type Block } from "@/components/RichDoc";

type Comment = {
  id: string; paragraphIndex: number; quote: string; body: string;
  category: string; suggestedText: string | null; status: string; createdAt: string;
  authorRole: string; author: { name: string; isAI: boolean };
};
type RevisionMeta = {
  id: string; number: number; summary: string; createdAt: string;
  authorRole: string; author: { name: string; isAI: boolean };
};
type ManuscriptDetail = {
  id: string; title: string; status: string; content: string; docJson: string; myRole: string;
  project: { id: string; title: string; standards: string };
  comments: Comment[]; revisions: RevisionMeta[];
};

export default function ManuscriptPage() {
  const { id } = useParams<{ id: string }>();
  const [ms, setMs] = useState<ManuscriptDetail | null>(null);
  const [error, setError] = useState("");
  const [tab, setTab] = useState<"comments" | "history">("comments");
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [draftBlocks, setDraftBlocks] = useState<Block[]>([]);
  const [summary, setSummary] = useState("");
  const [selectedPara, setSelectedPara] = useState<number | null>(null);
  const [commentBody, setCommentBody] = useState("");
  const [commentCategory, setCommentCategory] = useState("GENERAL");
  const [suggestText, setSuggestText] = useState("");
  const [withSuggestion, setWithSuggestion] = useState(false);
  const [aiBusy, setAiBusy] = useState(false);
  const [reviseBusy, setReviseBusy] = useState<string | null>(null);
  const [diffTarget, setDiffTarget] = useState<{ number: number; content: string } | null>(null);
  const [toast, setToast] = useState("");

  const load = useCallback(() => {
    api<ManuscriptDetail>(`/manuscripts/${id}`)
      .then((m) => { setMs(m); setDraft(m.content); })
      .catch((e) => setError(e.message));
  }, [id]);
  useEffect(load, [load]);

  function flash(msg: string) {
    setToast(msg);
    setTimeout(() => setToast(""), 3000);
  }

  if (error) return (<><TopBar /><main className="container page"><div className="empty">{error}</div></main></>);
  if (!ms) return (<><TopBar /><main className="container page"><div className="empty">加载中…</div></main></>);

  const docBlocks = parseDoc(ms.docJson);
  const isRich = docBlocks !== null;
  const paragraphs = ms.content.split(/\n\n/);
  const unitCount = isRich ? docBlocks.length : paragraphs.length;
  const unitText = (i: number) => isRich ? (docBlocks[i] ? blockPreview(docBlocks[i]) : "") : (paragraphs[i] ?? "");
  const isChief = ms.myRole === "CHIEF_EDITOR";
  const finalized = ms.status === "FINALIZED";
  const openComments = ms.comments.filter((c) => c.status === "OPEN");
  const countByPara = new Map<number, number>();
  for (const c of openComments) countByPara.set(c.paragraphIndex, (countByPara.get(c.paragraphIndex) ?? 0) + 1);

  async function saveContent() {
    try {
      const body = isRich ? { docJson: { blocks: draftBlocks }, summary } : { content: draft, summary };
      const r = await api<{ revisionNumber: number }>(`/manuscripts/${id}/content`, { method: "PUT", body });
      setEditing(false);
      setSummary("");
      load();
      flash(`已保存为第 ${r.revisionNumber} 版`);
    } catch (err) { flash(err instanceof Error ? err.message : "保存失败"); }
  }

  async function submitComment() {
    if (selectedPara === null) return;
    try {
      await api(`/manuscripts/${id}/comments`, {
        method: "POST",
        body: {
          paragraphIndex: selectedPara,
          quote: unitText(selectedPara)?.slice(0, 30) ?? "",
          body: commentBody,
          category: commentCategory,
          suggestedText: withSuggestion && suggestText.trim() ? suggestText : undefined,
        },
      });
      setCommentBody(""); setSuggestText(""); setWithSuggestion(false); setSelectedPara(null);
      load();
      flash("意见已提交");
    } catch (err) { flash(err instanceof Error ? err.message : "提交失败"); }
  }

  async function updateComment(commentId: string, status: string) {
    try {
      await api(`/manuscripts/${id}/comments/${commentId}`, { method: "PATCH", body: { status } });
      load();
      flash(status === "ACCEPTED" ? "建议已采纳并生成新版本" : "已更新");
    } catch (err) { flash(err instanceof Error ? err.message : "操作失败"); }
  }

  async function aiRevise(commentId: string) {
    setReviseBusy(commentId);
    try {
      await api(`/ai/manuscripts/${id}/comments/${commentId}/revise`, { method: "POST" });
      load();
      flash("AI 已按意见生成修改建议，请复核后采纳");
    } catch (err) { flash(err instanceof Error ? err.message : "AI 改写失败"); }
    finally { setReviseBusy(null); }
  }

  async function runAI() {
    setAiBusy(true);
    try {
      const r = await api<{ engine: string; count: number }>(`/ai/manuscripts/${id}/review`, { method: "POST" });
      load();
      flash(r.engine === "claude" ? `AI 审校完成，生成 ${r.count} 条建议` : `演示模式：生成 ${r.count} 条示例建议（配置 ANTHROPIC_API_KEY 后启用真实 AI）`);
    } catch (err) { flash(err instanceof Error ? err.message : "AI 审校失败"); }
    finally { setAiBusy(false); }
  }

  async function viewDiff(number: number) {
    try {
      const rev = await api<{ number: number; content: string }>(`/manuscripts/${id}/revisions/${number}`);
      setDiffTarget({ number: rev.number, content: rev.content });
    } catch (err) { flash(err instanceof Error ? err.message : "加载失败"); }
  }

  async function rollback(number: number) {
    if (!confirm(`确认回滚到第 ${number} 版？将生成一个内容相同的新版本，历史不会丢失。`)) return;
    try {
      await api(`/manuscripts/${id}/rollback`, { method: "POST", body: { number } });
      setDiffTarget(null);
      load();
      flash("已回滚");
    } catch (err) { flash(err instanceof Error ? err.message : "回滚失败"); }
  }

  return (
    <>
      <TopBar />
      <main className="container page">
        <div className="page-head">
          <div style={{ flex: 1 }}>
            <div className="muted small">
              <Link href="/dashboard">项目列表</Link> / <Link href={`/projects/${ms.project.id}`}>{ms.project.title}</Link> / 书稿
            </div>
            <h1>{ms.title}</h1>
          </div>
          <span className={`badge ${finalized ? "badge-ok" : "badge-warn"}`}>{STATUS_LABEL[ms.status]}</span>
          <button className="btn btn-ghost btn-sm" title="导出为 Markdown" onClick={() => downloadFile(`/manuscripts/${id}/export?format=md`).catch((e) => flash(e.message))}>导出 MD</button>
          <button className="btn btn-ghost btn-sm" title="导出为 HTML" onClick={() => downloadFile(`/manuscripts/${id}/export?format=html`).catch((e) => flash(e.message))}>导出 HTML</button>
          {isChief && (
            <button
              className={`btn ${finalized ? "btn-ghost" : ""}`}
              onClick={async () => {
                try {
                  await api(`/manuscripts/${id}/finalize`, { method: "POST", body: { finalize: !finalized } });
                  load();
                  flash(finalized ? "已解除定稿" : "已定稿锁定");
                } catch (err) { flash(err instanceof Error ? err.message : "操作失败"); }
              }}
            >
              {finalized ? "解除定稿" : "定稿锁定"}
            </button>
          )}
        </div>

        <div className="workspace">
          {/* 左：书稿正文 */}
          <div className="card" style={{ paddingLeft: 48 }}>
            <div style={{ display: "flex", gap: 8, marginBottom: 16, alignItems: "center" }}>
              <h2 style={{ flex: 1, margin: 0 }}>书稿正文</h2>
              {!editing && !finalized && ms.myRole !== "AI_ASSISTANT" && (
                <button className="btn btn-ghost btn-sm" onClick={() => { setDraft(ms.content); setDraftBlocks(docBlocks ? JSON.parse(JSON.stringify(docBlocks)) : []); setSelectedPara(null); setEditing(true); }}>进入编辑</button>
              )}
              <button className="btn btn-sm" onClick={runAI} disabled={aiBusy || editing}>
                {aiBusy ? "AI 审校中…" : "🤖 AI 智能审校"}
              </button>
            </div>

            {editing ? (
              <div>
                {isRich ? (
                  <RichDocEditor blocks={draftBlocks} onChange={setDraftBlocks} />
                ) : (
                  <textarea className="textarea editor-area" value={draft} onChange={(e) => setDraft(e.target.value)} />
                )}
                <div className="field" style={{ marginTop: 12 }}>
                  <label>修订说明（必填，将写入修订记录）</label>
                  <input className="input" value={summary} onChange={(e) => setSummary(e.target.value)} placeholder="例如：统一术语；修正第 3 段表述" />
                </div>
                <div style={{ display: "flex", gap: 8 }}>
                  <button className="btn" onClick={saveContent} disabled={!summary.trim()}>保存为新版本</button>
                  <button className="btn btn-ghost" onClick={() => { setEditing(false); setDraft(ms.content); }}>放弃修改</button>
                </div>
              </div>
            ) : isRich ? (
              docBlocks.length === 0 ? (
                <div className="empty">暂无内容。</div>
              ) : (
                <RichDocView blocks={docBlocks} selectedIndex={selectedPara} onSelect={(i) => setSelectedPara(selectedPara === i ? null : i)} countByIndex={countByPara} />
              )
            ) : (
              <div className="manuscript-body">
                {paragraphs.length === 1 && !paragraphs[0].trim() ? (
                  <div className="empty">暂无内容。点击「进入编辑」粘贴书稿正文（段落之间用空行分隔）。</div>
                ) : (
                  paragraphs.map((p, i) => (
                    <p
                      key={i}
                      className={`paragraph ${selectedPara === i ? "selected" : ""} ${countByPara.has(i) ? "has-comments" : ""}`}
                      data-count={countByPara.get(i) ?? ""}
                      title="点击此段落发表审阅意见"
                      onClick={() => setSelectedPara(selectedPara === i ? null : i)}
                    >
                      <span className="p-index">¶{i + 1}</span>
                      {p}
                    </p>
                  ))
                )}
              </div>
            )}

            {/* 段落评论表单 */}
            {selectedPara !== null && !editing && ms.myRole !== "AI_ASSISTANT" && (
              <div className="card" style={{ marginTop: 16, background: "var(--warn-tint)", borderColor: "var(--warn)" }}>
                <h2>对第 {selectedPara + 1} 段提出审阅意见</h2>
                <div className="field">
                  <select className="select" value={commentCategory} onChange={(e) => setCommentCategory(e.target.value)}>
                    {Object.entries(CATEGORY_LABEL).map(([k, v]) => (
                      <option key={k} value={k}>{v}</option>
                    ))}
                  </select>
                </div>
                <div className="field">
                  <textarea className="textarea" rows={3} placeholder="意见内容…" value={commentBody} onChange={(e) => setCommentBody(e.target.value)} />
                </div>
                <label className="small" style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 8 }}>
                  <input type="checkbox" checked={withSuggestion} onChange={(e) => setWithSuggestion(e.target.checked)} />
                  附带修改建议（主编可一键采纳，整段替换）
                </label>
                {withSuggestion && (
                  <div className="field">
                    <textarea className="textarea editor-area" style={{ minHeight: 120 }} placeholder="修改后的整段文本…" value={suggestText || unitText(selectedPara)} onChange={(e) => setSuggestText(e.target.value)} />
                  </div>
                )}
                <div style={{ display: "flex", gap: 8 }}>
                  <button className="btn" onClick={submitComment} disabled={!commentBody.trim()}>提交意见</button>
                  <button className="btn btn-ghost" onClick={() => setSelectedPara(null)}>取消</button>
                </div>
              </div>
            )}
          </div>

          {/* 右：意见与修订历史 */}
          <div className="card">
            <div className="side-tabs">
              <button className={tab === "comments" ? "active" : ""} onClick={() => setTab("comments")}>
                审阅意见（{openComments.length}）
              </button>
              <button className={tab === "history" ? "active" : ""} onClick={() => setTab("history")}>
                修订历史（{ms.revisions.length}）
              </button>
            </div>

            {tab === "comments" && (
              <div>
                {ms.comments.length === 0 && <div className="empty">暂无意见。点击左侧任一段落发表意见，或运行 AI 智能审校。</div>}
                {ms.comments.map((c) => (
                  <div key={c.id} className={`comment-item ${c.author.isAI ? "ai" : ""}`}>
                    <div className="comment-head">
                      <span className="who">{c.author.isAI ? "🤖 " : ""}{c.author.name}</span>
                      <span className="badge badge-gray">{ROLE_LABEL[c.authorRole]}</span>
                      <span className="badge">{CATEGORY_LABEL[c.category]}</span>
                      <span className={`badge ${c.status === "OPEN" ? "badge-warn" : c.status === "ACCEPTED" ? "badge-ok" : "badge-gray"}`}>
                        {STATUS_LABEL[c.status]}
                      </span>
                    </div>
                    <div className="muted small">第 {c.paragraphIndex + 1} 段 · {new Date(c.createdAt).toLocaleString("zh-CN")}</div>
                    {c.quote && <div className="comment-quote">「{c.quote}…」</div>}
                    <div className="comment-body">{c.body}</div>
                    {c.suggestedText && (
                      <div className="comment-suggest">
                        <span className="label">修改建议（整段替换）</span>
                        {c.suggestedText}
                      </div>
                    )}
                    {c.status === "OPEN" && (
                      <div className="comment-actions">
                        {c.suggestedText && isChief && !finalized && (
                          <>
                            <button className="btn btn-sm" onClick={() => updateComment(c.id, "ACCEPTED")}>采纳建议</button>
                            <button className="btn btn-danger btn-sm" onClick={() => updateComment(c.id, "REJECTED")}>驳回</button>
                          </>
                        )}
                        {!c.suggestedText && !finalized && ms.myRole !== "AI_ASSISTANT" && (
                          <button className="btn btn-sm" disabled={reviseBusy === c.id} onClick={() => aiRevise(c.id)}>
                            {reviseBusy === c.id ? "AI 改写中…" : "🤖 让 AI 按此意见改写"}
                          </button>
                        )}
                        <button className="btn btn-ghost btn-sm" onClick={() => updateComment(c.id, "RESOLVED")}>标记已解决</button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}

            {tab === "history" && (
              <div>
                {ms.revisions.length === 0 && <div className="empty">暂无修订记录</div>}
                {ms.revisions.map((r) => (
                  <div key={r.id} className="revision-item">
                    <div className="revision-num">V{r.number}</div>
                    <div style={{ flex: 1 }}>
                      <div><strong>{r.author.isAI ? "🤖 " : ""}{r.author.name}</strong> <span className="badge badge-gray">{ROLE_LABEL[r.authorRole]}</span></div>
                      <div className="small">{r.summary || "（无说明）"}</div>
                      <div className="muted small">{new Date(r.createdAt).toLocaleString("zh-CN")}</div>
                      <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
                        <button className="btn btn-ghost btn-sm" onClick={() => viewDiff(r.number)}>与当前版本对比</button>
                        {isChief && !finalized && r.number !== ms.revisions[0]?.number && (
                          <button className="btn btn-ghost btn-sm" onClick={() => rollback(r.number)}>回滚到此版</button>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Diff 弹层 */}
        {diffTarget && (
          <div
            style={{ position: "fixed", inset: 0, background: "rgba(38,41,46,0.45)", zIndex: 50, display: "grid", placeItems: "center", padding: 24 }}
            onClick={() => setDiffTarget(null)}
          >
            <div className="card" style={{ maxWidth: 800, width: "100%", maxHeight: "80vh", overflow: "auto" }} onClick={(e) => e.stopPropagation()}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
                <h2 style={{ flex: 1, margin: 0 }}>第 {diffTarget.number} 版 → 当前版本 对比</h2>
                <span className="badge badge-accent">红色删除线 = 旧版内容</span>
                <span className="badge badge-ok">绿色 = 当前新增</span>
                <button className="btn btn-ghost btn-sm" onClick={() => setDiffTarget(null)}>关闭</button>
              </div>
              <div className="diff-view">
                {diffChars(diffTarget.content, ms.content).map((part, i) => (
                  <span key={i} className={part.added ? "diff-add" : part.removed ? "diff-del" : ""}>
                    {part.value}
                  </span>
                ))}
              </div>
            </div>
          </div>
        )}
      </main>
      {toast && <div className="toast">{toast}</div>}
    </>
  );
}
