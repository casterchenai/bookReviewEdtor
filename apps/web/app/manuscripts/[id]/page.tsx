"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { diffChars } from "diff";
import TopBar from "@/components/TopBar";
import { api, downloadFile, CATEGORY_LABEL, ROLE_LABEL, STATUS_LABEL } from "@/lib/api";
import { RichDocView, RichDocEditor, parseDoc, blockPreview, type Block } from "@/components/RichDoc";
import CommentMargin from "@/components/CommentMargin";

type Comment = {
  id: string; paragraphIndex: number; quote: string; body: string;
  category: string; suggestedText: string | null; status: string; createdAt: string;
  authorRole: string; aiAgentName?: string | null; author: { name: string; isAI: boolean };
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
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [draftBlocks, setDraftBlocks] = useState<Block[]>([]);
  const [summary, setSummary] = useState("");
  const [selectedPara, setSelectedPara] = useState<number | null>(null);
  const [activeAnchor, setActiveAnchor] = useState<number | null>(null);
  const [commentBody, setCommentBody] = useState("");
  const [commentCategory, setCommentCategory] = useState("GENERAL");
  const [suggestText, setSuggestText] = useState("");
  const [withSuggestion, setWithSuggestion] = useState(false);
  const [scanOthers, setScanOthers] = useState(false);
  const [optimizing, setOptimizing] = useState(false);
  const [suggestBusy, setSuggestBusy] = useState(false);
  const [acceptAllOpen, setAcceptAllOpen] = useState(false);
  const [acceptAllSummary, setAcceptAllSummary] = useState("");
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const [aiBusy, setAiBusy] = useState(false);
  const [agents, setAgents] = useState<{ id: string; name: string; enabled: boolean }[]>([]);
  const [reviewAgent, setReviewAgent] = useState<string>(""); // "" 默认 · "ALL" 全部启用 · agentId
  const [reviseBusy, setReviseBusy] = useState<string | null>(null);
  const [diffView, setDiffView] = useState<{ title: string; a: string; b: string } | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [showSummary, setShowSummary] = useState(false);
  const [cmpA, setCmpA] = useState<string>("");
  const [cmpB, setCmpB] = useState<string>("current");
  const [toast, setToast] = useState("");
  const docRef = useRef<HTMLDivElement>(null);
  const revCache = useRef<Map<number, string>>(new Map());

  const load = useCallback(() => {
    api<ManuscriptDetail>(`/manuscripts/${id}`)
      .then((m) => { setMs(m); setDraft(m.content); })
      .catch((e) => setError(e.message));
  }, [id]);
  useEffect(load, [load]);
  useEffect(() => {
    const pid = ms?.project.id;
    if (pid) api<{ id: string; name: string; enabled: boolean }[]>(`/projects/${pid}/agents`).then(setAgents).catch(() => {});
  }, [ms?.project.id]);

  function flash(msg: string) { setToast(msg); setTimeout(() => setToast(""), 3000); }

  if (error) return (<><TopBar /><main className="container page"><div className="empty">{error}</div></main></>);
  if (!ms) return (<><TopBar /><main className="container page"><div className="empty">加载中…</div></main></>);

  const docBlocks = parseDoc(ms.docJson);
  const isRich = docBlocks !== null;
  const paragraphs = ms.content.split(/\n\n/);
  const unitText = (i: number) => isRich ? (docBlocks[i] ? blockPreview(docBlocks[i]) : "") : (paragraphs[i] ?? "");
  const isChief = ms.myRole === "CHIEF_EDITOR";
  const canReview = ms.myRole !== "AI_ASSISTANT";
  const finalized = ms.status === "FINALIZED";
  const openComments = ms.comments.filter((c) => c.status === "OPEN");
  const countByPara = new Map<number, number>();
  for (const c of openComments) countByPara.set(c.paragraphIndex, (countByPara.get(c.paragraphIndex) ?? 0) + 1);

  async function saveContent() {
    try {
      const body = isRich ? { docJson: { blocks: draftBlocks }, summary } : { content: draft, summary };
      const r = await api<{ revisionNumber: number }>(`/manuscripts/${id}/content`, { method: "PUT", body });
      setEditing(false); setSummary(""); revCache.current.clear(); load();
      flash(`已提交为第 ${r.revisionNumber} 版`);
    } catch (err) { flash(err instanceof Error ? err.message : "保存失败"); }
  }

  async function submitComment() {
    if (selectedPara === null) return;
    const opinion = commentBody, category = commentCategory, doScan = scanOthers;
    try {
      await api(`/manuscripts/${id}/comments`, {
        method: "POST",
        body: {
          paragraphIndex: selectedPara,
          quote: unitText(selectedPara)?.slice(0, 30) ?? "",
          body: opinion, category,
          suggestedText: withSuggestion && suggestText.trim() ? suggestText : undefined,
        },
      });
      setCommentBody(""); setSuggestText(""); setWithSuggestion(false); setScanOthers(false); setSelectedPara(null);
      load(); flash("意见已提交");
      if (doScan) scanOtherChapters(opinion, category);
    } catch (err) { flash(err instanceof Error ? err.message : "提交失败"); }
  }

  async function optimizeComment() {
    if (!commentBody.trim()) return;
    setOptimizing(true);
    try {
      const r = await api<{ text: string }>(`/ai/manuscripts/${id}/optimize`, { method: "POST", body: { text: commentBody } });
      setCommentBody(r.text); flash("已优化意见表达");
    } catch (err) { flash(err instanceof Error ? err.message : "优化失败"); }
    finally { setOptimizing(false); }
  }

  async function toggleWithSuggestion(checked: boolean) {
    setWithSuggestion(checked);
    if (!checked) { setSuggestText(""); return; }
    if (selectedPara === null) return;
    if (commentBody.trim()) {
      // 有意见：AI 按意见生成修改后的整段，作为默认值（可继续编辑）
      setSuggestBusy(true);
      try {
        const r = await api<{ suggestedText: string }>(`/ai/manuscripts/${id}/suggest`, { method: "POST", body: { paragraphIndex: selectedPara, opinion: commentBody } });
        setSuggestText(r.suggestedText);
      } catch (err) { flash(err instanceof Error ? err.message : "AI 生成失败"); setSuggestText(unitText(selectedPara)); }
      finally { setSuggestBusy(false); }
    } else {
      // 无意见：展开为原文，供直接编辑
      setSuggestText(unitText(selectedPara));
    }
  }

  async function scanOtherChapters(opinion: string, category: string) {
    try {
      const proj = await api<{ manuscripts: { id: string; status: string }[] }>(`/projects/${ms!.project.id}`);
      const others = proj.manuscripts.filter((m) => m.id !== id && m.status !== "FINALIZED");
      if (others.length === 0) return;
      let total = 0;
      for (let k = 0; k < others.length; k++) {
        flash(`检查其他章节同类问题 ${k + 1}/${others.length}…`);
        try { const r = await api<{ count: number }>(`/ai/manuscripts/${others[k].id}/scan-issue`, { method: "POST", body: { opinion, category } }); total += r.count; } catch { /* 单章失败继续 */ }
      }
      flash(`同类问题检查完成：其他章节共新增 ${total} 条意见`);
    } catch { flash("跨章节检查未完成"); }
  }

  async function saveTitle() {
    if (!titleDraft.trim()) { flash("标题不能为空"); return; }
    try {
      await api(`/manuscripts/${id}/title`, { method: "PATCH", body: { title: titleDraft.trim() } });
      setEditingTitle(false); load(); flash("标题已更新");
    } catch (err) { flash(err instanceof Error ? err.message : "改名失败"); }
  }

  async function acceptAll() {
    try {
      const r = await api<{ count: number }>(`/manuscripts/${id}/accept-all`, { method: "POST", body: { summary: acceptAllSummary.trim() || undefined } });
      setAcceptAllOpen(false); setAcceptAllSummary(""); revCache.current.clear(); load();
      flash(`已全部采纳 ${r.count} 条建议并生成新版本`);
    } catch (err) { flash(err instanceof Error ? err.message : "全部采纳失败"); }
  }

  async function updateComment(commentId: string, status: string) {
    try {
      await api(`/manuscripts/${id}/comments/${commentId}`, { method: "PATCH", body: { status } });
      revCache.current.clear(); load();
      flash(status === "ACCEPTED" ? "建议已采纳并生成新版本" : "已更新");
    } catch (err) { flash(err instanceof Error ? err.message : "操作失败"); }
  }

  async function aiRevise(commentId: string) {
    setReviseBusy(commentId);
    try {
      await api(`/ai/manuscripts/${id}/comments/${commentId}/revise`, { method: "POST" });
      load(); flash("AI 已按意见生成修改建议，请复核后采纳");
    } catch (err) { flash(err instanceof Error ? err.message : "AI 改写失败"); }
    finally { setReviseBusy(null); }
  }

  async function runAI() {
    setAiBusy(true);
    try {
      if (reviewAgent === "ALL") {
        const enabled = agents.filter((a) => a.enabled);
        if (enabled.length === 0) { flash("没有启用的智能体"); return; }
        let total = 0, skip = 0;
        for (let k = 0; k < enabled.length; k++) {
          flash(`智能体审校中 ${k + 1}/${enabled.length}：${enabled[k].name}…`);
          try { const r = await api<{ count: number; skipped: number }>(`/ai/manuscripts/${id}/review`, { method: "POST", body: { agentId: enabled[k].id } }); total += r.count; skip += r.skipped ?? 0; } catch { /* 单个失败继续 */ }
        }
        load(); flash(`全部智能体审校完成，共生成 ${total} 条${skip ? `（跳过 ${skip} 段已审校）` : ""}`);
      } else {
        const body = reviewAgent ? { agentId: reviewAgent } : {};
        const r = await api<{ engine: string; count: number; skipped: number; agent: string | null }>(`/ai/manuscripts/${id}/review`, { method: "POST", body });
        load();
        flash(r.engine === "stub" ? `演示模式：生成 ${r.count} 条示例建议（配置 AI 密钥后启用真实审校）` : `${r.agent ? r.agent + " " : "AI "}审校完成，生成 ${r.count} 条${r.skipped ? `（跳过 ${r.skipped} 段已审校）` : ""}`);
      }
    } catch (err) { flash(err instanceof Error ? err.message : "AI 审校失败"); }
    finally { setAiBusy(false); }
  }

  async function clearAiComments() {
    const aiCount = ms!.comments.filter((c) => c.author.isAI).length;
    if (!confirm(`确认清除本章全部 ${aiCount} 条 AI 审校意见？（不影响人工意见与版本历史，便于重新审校）`)) return;
    try {
      const r = await api<{ count: number }>(`/manuscripts/${id}/ai-comments`, { method: "DELETE" });
      load(); flash(`已清除 ${r.count} 条 AI 审校意见`);
    } catch (err) { flash(err instanceof Error ? err.message : "清除失败"); }
  }

  async function fetchRev(number: number): Promise<string> {
    if (revCache.current.has(number)) return revCache.current.get(number)!;
    const rev = await api<{ number: number; content: string }>(`/manuscripts/${id}/revisions/${number}`);
    revCache.current.set(number, rev.content);
    return rev.content;
  }

  async function compareVersions() {
    try {
      const aContent = cmpA === "current" ? ms!.content : await fetchRev(Number(cmpA));
      const bContent = cmpB === "current" ? ms!.content : await fetchRev(Number(cmpB));
      const label = (v: string) => v === "current" ? "当前版本" : `第 ${v} 版`;
      setDiffView({ title: `${label(cmpA)} → ${label(cmpB)} 对比`, a: aContent, b: bContent });
    } catch (err) { flash(err instanceof Error ? err.message : "加载失败"); }
  }

  async function quickDiff(number: number) {
    try {
      const c = await fetchRev(number);
      setDiffView({ title: `第 ${number} 版 → 当前版本 对比`, a: c, b: ms!.content });
    } catch (err) { flash(err instanceof Error ? err.message : "加载失败"); }
  }

  async function rollback(number: number) {
    if (!confirm(`确认回退到第 ${number} 版？将据此生成一个新版本，历史不会丢失（git 式提交）。`)) return;
    try {
      await api(`/manuscripts/${id}/rollback`, { method: "POST", body: { number } });
      revCache.current.clear(); setShowHistory(false); load(); flash("已回退并生成新版本");
    } catch (err) { flash(err instanceof Error ? err.message : "回退失败"); }
  }

  // 就近弹出的批注编辑器（点击段落后显示在该段正下方）
  const composer = (i: number) =>
    selectedPara === i && !editing && canReview ? (
      <div className="inline-composer" onClick={(e) => e.stopPropagation()}>
        <div className="ic-title">对 ¶{i + 1} 提出审阅意见</div>
        <select className="select" value={commentCategory} onChange={(e) => setCommentCategory(e.target.value)}>
          {Object.entries(CATEGORY_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <textarea className="textarea" rows={2} placeholder="意见内容…" value={commentBody} onChange={(e) => setCommentBody(e.target.value)} autoFocus />
        <div className="ic-row">
          <button className="btn btn-ghost btn-sm" disabled={optimizing || !commentBody.trim()} onClick={optimizeComment}>
            {optimizing ? "优化中…" : "🤖 AI 优化"}
          </button>
          <label className="small" style={{ display: "flex", gap: 4, alignItems: "center" }}>
            <input type="checkbox" checked={scanOthers} onChange={(e) => setScanOthers(e.target.checked)} />
            顺带查其他章节同类问题
          </label>
        </div>
        <label className="small" style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <input type="checkbox" checked={withSuggestion} onChange={(e) => toggleWithSuggestion(e.target.checked)} />
          附带修改建议（主编可一键采纳，整段替换）{suggestBusy && " · AI 生成中…"}
        </label>
        {withSuggestion && (
          <>
            <textarea className="textarea editor-area" style={{ minHeight: 90 }} placeholder="修改后的整段文本…" value={suggestText} onChange={(e) => setSuggestText(e.target.value)} />
            <div className="suggest-diff-label">修改痕迹（荧光笔高亮，对比原文实时更新）</div>
            <div className="suggest-diff">
              {diffChars(unitText(i), suggestText).map((part, k) => (
                <span key={k} className={part.added ? "hl-add" : part.removed ? "hl-del" : ""}>{part.value}</span>
              ))}
            </div>
          </>
        )}
        <div style={{ display: "flex", gap: 8 }}>
          <button className="btn btn-sm" onClick={submitComment} disabled={!commentBody.trim() || suggestBusy}>提交意见</button>
          <button className="btn btn-ghost btn-sm" onClick={() => { setSelectedPara(null); setWithSuggestion(false); setScanOthers(false); setSuggestText(""); }}>取消</button>
        </div>
      </div>
    ) : null;

  const roleStats = computeSummary(ms.comments);

  return (
    <>
      <TopBar />
      <main className="container page">
        <div className="page-head">
          <div style={{ flex: 1 }}>
            <div className="muted small">
              <Link href="/dashboard">项目列表</Link> / <Link href={`/projects/${ms.project.id}`}>{ms.project.title}</Link> / 书稿
            </div>
            {editingTitle ? (
              <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 4 }}>
                <input className="input" style={{ fontSize: "1.2rem", fontWeight: 700, maxWidth: 520 }} value={titleDraft} onChange={(e) => setTitleDraft(e.target.value)} autoFocus />
                <button className="btn btn-sm" onClick={saveTitle}>保存</button>
                <button className="btn btn-ghost btn-sm" onClick={() => setEditingTitle(false)}>取消</button>
              </div>
            ) : (
              <h1 style={{ display: "flex", gap: 10, alignItems: "center" }}>
                {ms.title}
                {isChief && !finalized && (
                  <button className="btn btn-ghost btn-sm" onClick={() => { setTitleDraft(ms.title); setEditingTitle(true); }}>改名</button>
                )}
              </h1>
            )}
          </div>
          <span className={`badge ${finalized ? "badge-ok" : "badge-warn"}`}>{STATUS_LABEL[ms.status]}</span>
          <button className="btn btn-ghost btn-sm" onClick={() => setShowHistory(true)}>修订历史（{ms.revisions.length}）</button>
          <button className="btn btn-ghost btn-sm" onClick={() => setShowSummary(true)}>审阅汇总</button>
          <button className="btn btn-ghost btn-sm" onClick={() => downloadFile(`/manuscripts/${id}/export?format=md`).catch((e) => flash(e.message))}>导出 MD</button>
          <button className="btn btn-ghost btn-sm" onClick={() => downloadFile(`/manuscripts/${id}/export?format=html`).catch((e) => flash(e.message))}>导出 HTML</button>
          {isChief && (
            <button className={`btn ${finalized ? "btn-ghost" : ""}`} onClick={async () => {
              try { await api(`/manuscripts/${id}/finalize`, { method: "POST", body: { finalize: !finalized } }); load(); flash(finalized ? "已解除定稿" : "已定稿锁定"); }
              catch (err) { flash(err instanceof Error ? err.message : "操作失败"); }
            }}>{finalized ? "解除定稿" : "定稿锁定"}</button>
          )}
        </div>

        <div className="review-workspace">
          {/* 左：书稿正文 */}
          <div className="card doc-col" ref={docRef}>
            <div style={{ display: "flex", gap: 8, marginBottom: 16, alignItems: "center" }}>
              <h2 style={{ flex: 1, margin: 0 }}>书稿正文</h2>
              {!editing && !finalized && canReview && (
                <button className="btn btn-ghost btn-sm" onClick={() => { setDraft(ms.content); setDraftBlocks(docBlocks ? JSON.parse(JSON.stringify(docBlocks)) : []); setSelectedPara(null); setEditing(true); }}>进入编辑</button>
              )}
              {agents.filter((a) => a.enabled).length > 0 && (
                <select className="select" style={{ width: "auto", height: 32 }} value={reviewAgent} onChange={(e) => setReviewAgent(e.target.value)} disabled={aiBusy || editing} title="选择审校智能体">
                  <option value="">默认审校</option>
                  {agents.filter((a) => a.enabled).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                  <option value="ALL">▶ 全部智能体</option>
                </select>
              )}
              <button className="btn btn-sm" onClick={runAI} disabled={aiBusy || editing}>{aiBusy ? "AI 审校中…" : "🤖 AI 智能审校"}</button>
              {ms.comments.some((c) => c.author.isAI) && (
                <button className="btn btn-ghost btn-sm" onClick={clearAiComments} disabled={aiBusy || editing} title="清除本章全部 AI 审校意见">清除 AI 意见</button>
              )}
              {isChief && !finalized && openComments.some((c) => c.suggestedText) && (
                <button className="btn btn-sm" onClick={() => setAcceptAllOpen(true)} disabled={editing}>
                  ✓ 全部采纳（{openComments.filter((c) => c.suggestedText).length}）
                </button>
              )}
            </div>

            {editing ? (
              <div>
                {isRich ? <RichDocEditor blocks={draftBlocks} onChange={setDraftBlocks} /> : <textarea className="textarea editor-area" value={draft} onChange={(e) => setDraft(e.target.value)} />}
                <div className="field" style={{ marginTop: 12 }}>
                  <label>修订说明（必填，作为本次版本的提交信息）</label>
                  <input className="input" value={summary} onChange={(e) => setSummary(e.target.value)} placeholder="例如：统一术语；修正第 3 段表述" />
                </div>
                <div style={{ display: "flex", gap: 8 }}>
                  <button className="btn" onClick={saveContent} disabled={!summary.trim()}>提交为新版本</button>
                  <button className="btn btn-ghost" onClick={() => { setEditing(false); setDraft(ms.content); }}>放弃修改</button>
                </div>
              </div>
            ) : isRich ? (
              docBlocks.length === 0 ? <div className="empty">暂无内容。</div> : (
                <RichDocView
                  blocks={docBlocks} selectedIndex={selectedPara}
                  onSelect={(i) => setSelectedPara(selectedPara === i ? null : i)}
                  countByIndex={countByPara} idPrefix="u-" renderAfter={composer}
                />
              )
            ) : (
              <div className="manuscript-body">
                {paragraphs.length === 1 && !paragraphs[0].trim() ? (
                  <div className="empty">暂无内容。点击「进入编辑」粘贴书稿正文（段落之间用空行分隔）。</div>
                ) : (
                  paragraphs.map((p, i) => (
                    <div key={i}>
                      <p id={`u-${i}`}
                        className={`paragraph ${selectedPara === i ? "selected" : ""} ${countByPara.has(i) ? "has-comments" : ""}`}
                        data-count={countByPara.get(i) ?? ""} title="点击此段落发表审阅意见"
                        onClick={() => setSelectedPara(selectedPara === i ? null : i)}>
                        <span className="p-index">¶{i + 1}</span>{p}
                      </p>
                      {composer(i)}
                    </div>
                  ))
                )}
              </div>
            )}
          </div>

          {/* 右：批注栏（按段落对齐） */}
          {!editing && (
            <div className="margin-col">
              <CommentMargin
                comments={ms.comments} containerRef={docRef} idPrefix="u-"
                onAction={updateComment} onAiRevise={aiRevise}
                onFocusAnchor={setActiveAnchor}
                isChief={isChief} finalized={finalized} canReview={canReview}
                reviseBusy={reviseBusy} activeAnchor={activeAnchor}
              />
            </div>
          )}
        </div>

        {/* 对比弹层 */}
        {diffView && (
          <div className="modal-overlay" onClick={() => setDiffView(null)}>
            <div className="card modal-card" onClick={(e) => e.stopPropagation()}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
                <h2 style={{ flex: 1, margin: 0 }}>{diffView.title}</h2>
                <span className="badge badge-accent">红色删除线 = 旧</span>
                <span className="badge badge-ok">绿色 = 新</span>
                <button className="btn btn-ghost btn-sm" onClick={() => setDiffView(null)}>关闭</button>
              </div>
              <div className="diff-view">
                {diffChars(diffView.a, diffView.b).map((part, i) => (
                  <span key={i} className={part.added ? "diff-add" : part.removed ? "diff-del" : ""}>{part.value}</span>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* 修订历史弹层（git 式提交日志 + 任意版本对比/回退） */}
        {showHistory && (
          <div className="modal-overlay" onClick={() => setShowHistory(false)}>
            <div className="card modal-card" onClick={(e) => e.stopPropagation()}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
                <h2 style={{ flex: 1, margin: 0 }}>修订历史 · 版本管理</h2>
                <button className="btn btn-ghost btn-sm" onClick={() => setShowHistory(false)}>关闭</button>
              </div>
              <div className="cmp-bar">
                <span className="small muted">任意版本对比：</span>
                <select className="select" value={cmpA} onChange={(e) => setCmpA(e.target.value)}>
                  <option value="">选择版本</option>
                  {ms.revisions.map((r) => <option key={r.id} value={r.number}>第 {r.number} 版</option>)}
                </select>
                <span>→</span>
                <select className="select" value={cmpB} onChange={(e) => setCmpB(e.target.value)}>
                  <option value="current">当前版本</option>
                  {ms.revisions.map((r) => <option key={r.id} value={r.number}>第 {r.number} 版</option>)}
                </select>
                <button className="btn btn-sm" disabled={!cmpA} onClick={compareVersions}>对比</button>
              </div>
              <div className="commit-log">
                {ms.revisions.length === 0 && <div className="empty">暂无版本</div>}
                {ms.revisions.map((r) => (
                  <div key={r.id} className="commit-item">
                    <div className="commit-dot" />
                    <div style={{ flex: 1 }}>
                      <div><strong>V{r.number}</strong> · {r.summary || "（无说明）"}</div>
                      <div className="muted small">{r.author.isAI ? "🤖 " : ""}{r.author.name} · {ROLE_LABEL[r.authorRole] ?? r.authorRole} · {new Date(r.createdAt).toLocaleString("zh-CN")}</div>
                      <div style={{ display: "flex", gap: 6, marginTop: 4 }}>
                        <button className="btn btn-ghost btn-sm" onClick={() => quickDiff(r.number)}>与当前对比</button>
                        {isChief && !finalized && r.number !== ms.revisions[0]?.number && (
                          <button className="btn btn-ghost btn-sm" onClick={() => rollback(r.number)}>回退到此版</button>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* 全部采纳对话框 */}
        {acceptAllOpen && (
          <div className="modal-overlay" onClick={() => setAcceptAllOpen(false)}>
            <div className="card modal-card" style={{ maxWidth: 520 }} onClick={(e) => e.stopPropagation()}>
              <h2 style={{ marginTop: 0 }}>全部采纳修改建议</h2>
              <p className="muted small">
                将采纳全部 {openComments.filter((c) => c.suggestedText).length} 条含修改建议的待处理意见，合并应用并生成一个新版本（历史保留，可回退）。
              </p>
              <div className="field">
                <label>版本说明（可选）</label>
                <textarea className="textarea" rows={2} value={acceptAllSummary} onChange={(e) => setAcceptAllSummary(e.target.value)}
                  placeholder="留空则自动汇总，例如：采纳 主编 3 条、审校员 2 条修订意见" />
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <button className="btn" onClick={acceptAll}>确认全部采纳</button>
                <button className="btn btn-ghost" onClick={() => setAcceptAllOpen(false)}>取消</button>
              </div>
            </div>
          </div>
        )}

        {/* 审阅修订汇总表 */}
        {showSummary && (
          <div className="modal-overlay" onClick={() => setShowSummary(false)}>
            <div className="card modal-card" onClick={(e) => e.stopPropagation()}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
                <h2 style={{ flex: 1, margin: 0 }}>审阅修订记录汇总</h2>
                <button className="btn btn-ghost btn-sm" onClick={() => setShowSummary(false)}>关闭</button>
              </div>
              <div className="muted small" style={{ marginBottom: 8 }}>
                当前共 {ms.revisions.length} 个版本、{ms.comments.length} 条审阅意见。各角色贡献统计：
              </div>
              <table className="admin-table">
                <thead>
                  <tr><th>角色</th><th>提出意见</th><th>含修改建议</th><th>已采纳</th><th>已驳回</th><th>已解决</th><th>待处理</th></tr>
                </thead>
                <tbody>
                  {roleStats.length === 0 && <tr><td colSpan={7} className="muted small">暂无审阅意见</td></tr>}
                  {roleStats.map((s) => (
                    <tr key={s.role}>
                      <td><strong>{ROLE_LABEL[s.role] ?? s.role}</strong></td>
                      <td>{s.total}</td><td>{s.suggestions}</td><td>{s.accepted}</td>
                      <td>{s.rejected}</td><td>{s.resolved}</td><td>{s.open}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </main>
      {toast && <div className="toast">{toast}</div>}
    </>
  );
}

type RoleStat = { role: string; total: number; suggestions: number; accepted: number; rejected: number; resolved: number; open: number };
function computeSummary(comments: Comment[]): RoleStat[] {
  const map = new Map<string, RoleStat>();
  for (const c of comments) {
    const s = map.get(c.authorRole) ?? { role: c.authorRole, total: 0, suggestions: 0, accepted: 0, rejected: 0, resolved: 0, open: 0 };
    s.total++;
    if (c.suggestedText) s.suggestions++;
    if (c.status === "ACCEPTED") s.accepted++;
    else if (c.status === "REJECTED") s.rejected++;
    else if (c.status === "RESOLVED") s.resolved++;
    else s.open++;
    map.set(c.authorRole, s);
  }
  return [...map.values()];
}
