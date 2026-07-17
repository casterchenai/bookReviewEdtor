"use client";
// 右侧批注栏：每张卡片按其锚定段落纵向对齐；重叠时向下堆叠避让，
// 默认折叠为小标题，点击展开；空间不足时仍尽量贴近锚定段落。
import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { CATEGORY_LABEL, ROLE_LABEL, STATUS_LABEL } from "@/lib/api";

export type MarginComment = {
  id: string; paragraphIndex: number; quote: string; body: string;
  category: string; suggestedText: string | null; status: string; createdAt: string;
  authorRole: string; author: { name: string; isAI: boolean };
};

export default function CommentMargin({
  comments, containerRef, idPrefix, onAction, onAiRevise, onFocusAnchor,
  isChief, finalized, canReview, reviseBusy, activeAnchor,
}: {
  comments: MarginComment[];
  containerRef: React.RefObject<HTMLDivElement | null>;
  idPrefix: string;
  onAction: (id: string, status: string) => void;
  onAiRevise: (id: string) => void;
  onFocusAnchor: (index: number) => void;
  isChief: boolean;
  finalized: boolean;
  canReview: boolean;
  reviseBusy: string | null;
  activeAnchor: number | null;
}) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const [tops, setTops] = useState<Record<string, number>>({});
  const cardRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const [tick, setTick] = useState(0);

  // 内容/窗口变化时重新测量
  useLayoutEffect(() => {
    const onResize = () => setTick((t) => t + 1);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const measure = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;
    const cTop = container.getBoundingClientRect().top;
    const sorted = [...comments].sort((a, b) => {
      if (a.paragraphIndex !== b.paragraphIndex) return a.paragraphIndex - b.paragraphIndex;
      return a.createdAt.localeCompare(b.createdAt);
    });
    const next: Record<string, number> = {};
    let cursor = 0;
    const GAP = 8;
    for (const c of sorted) {
      const anchor = document.getElementById(`${idPrefix}${c.paragraphIndex}`);
      const desired = anchor ? anchor.getBoundingClientRect().top - cTop : cursor;
      const top = Math.max(desired, cursor);
      next[c.id] = top;
      const h = cardRefs.current.get(c.id)?.offsetHeight ?? 52;
      cursor = top + h + GAP;
    }
    // 仅在变化时更新，避免无限循环
    setTops((prev) => {
      const keys = Object.keys(next);
      if (keys.length === Object.keys(prev).length && keys.every((k) => Math.abs((prev[k] ?? -1) - next[k]) < 0.5)) return prev;
      return next;
    });
  }, [comments, containerRef, idPrefix]);

  useLayoutEffect(() => { measure(); }, [measure, expanded, tick]);

  return (
    <div className="comment-margin" style={{ minHeight: containerRef.current?.offsetHeight ?? undefined }}>
      {comments.length === 0 && <div className="empty small">点击左侧任一段落发表意见，或运行 AI 智能审校。</div>}
      {comments.map((c) => {
        const isOpen = expanded === c.id;
        const active = activeAnchor === c.paragraphIndex;
        return (
          <div
            key={c.id}
            ref={(el) => { if (el) cardRefs.current.set(c.id, el); else cardRefs.current.delete(c.id); }}
            className={`margin-card ${c.author.isAI ? "ai" : ""} ${isOpen ? "open" : "collapsed"} ${active ? "active" : ""} ${c.status !== "OPEN" ? "resolved" : ""}`}
            style={{ top: tops[c.id] ?? 0 }}
            onMouseEnter={() => onFocusAnchor(c.paragraphIndex)}
            onClick={() => { setExpanded(isOpen ? null : c.id); onFocusAnchor(c.paragraphIndex); }}
          >
            <div className="mc-head">
              <span className="mc-who">{c.author.isAI ? "🤖 " : ""}{c.author.name}</span>
              <span className="badge badge-gray mc-role">{ROLE_LABEL[c.authorRole] ?? c.authorRole}</span>
              <span className="mc-anchor">¶{c.paragraphIndex + 1}</span>
              {c.status !== "OPEN" && <span className={`badge ${c.status === "ACCEPTED" ? "badge-ok" : "badge-gray"}`}>{STATUS_LABEL[c.status]}</span>}
            </div>
            {!isOpen ? (
              <div className="mc-preview">{c.body}</div>
            ) : (
              <div className="mc-full" onClick={(e) => e.stopPropagation()}>
                <div className="badge" style={{ marginBottom: 4 }}>{CATEGORY_LABEL[c.category] ?? c.category}</div>
                {c.quote && <div className="comment-quote">「{c.quote}…」</div>}
                <div className="comment-body">{c.body}</div>
                {c.suggestedText && (
                  <div className="comment-suggest"><span className="label">修改建议（整段替换）</span>{c.suggestedText}</div>
                )}
                {c.status === "OPEN" && !finalized && (
                  <div className="comment-actions">
                    {c.suggestedText && isChief && (
                      <>
                        <button className="btn btn-sm" onClick={() => onAction(c.id, "ACCEPTED")}>采纳</button>
                        <button className="btn btn-danger btn-sm" onClick={() => onAction(c.id, "REJECTED")}>驳回</button>
                      </>
                    )}
                    {!c.suggestedText && canReview && (
                      <button className="btn btn-sm" disabled={reviseBusy === c.id} onClick={() => onAiRevise(c.id)}>
                        {reviseBusy === c.id ? "AI 改写中…" : "🤖 AI 按此意见改写"}
                      </button>
                    )}
                    <button className="btn btn-ghost btn-sm" onClick={() => onAction(c.id, "RESOLVED")}>已解决</button>
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
