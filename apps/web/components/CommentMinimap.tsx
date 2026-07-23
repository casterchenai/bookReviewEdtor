"use client";
// 右侧迷你滑块：每条审校意见一个小横杠，按其锚定段落在全文中的位置排布。
// 悬停变粗并显示提示，点击把窗口滚动锚定到对应段落。
import { useEffect, useState } from "react";
import { CATEGORY_LABEL, ROLE_LABEL } from "@/lib/api";

type C = {
  id: string; paragraphIndex: number; body: string; category: string; status: string;
  authorRole: string; aiAgentName?: string | null; author: { name: string; isAI: boolean };
};

export default function CommentMinimap({ comments, idPrefix }: { comments: C[]; idPrefix: string }) {
  const [ticks, setTicks] = useState<{ c: C; top: number }[]>([]);
  const [hover, setHover] = useState<string | null>(null);

  useEffect(() => {
    let raf = 0;
    function measure() {
      const docH = document.documentElement.scrollHeight || 1;
      const stripH = window.innerHeight;
      const next: { c: C; top: number }[] = [];
      for (const c of comments) {
        const el = document.getElementById(`${idPrefix}${c.paragraphIndex}`);
        if (!el) continue;
        const anchorTop = el.getBoundingClientRect().top + window.scrollY;
        next.push({ c, top: Math.min(stripH - 4, Math.max(2, (anchorTop / docH) * stripH)) });
      }
      setTicks(next);
    }
    const schedule = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(measure); };
    schedule();
    const t = setTimeout(schedule, 400); // 等富内容/批注布局稳定
    window.addEventListener("resize", schedule);
    return () => { window.removeEventListener("resize", schedule); clearTimeout(t); cancelAnimationFrame(raf); };
  }, [comments, idPrefix]);

  if (ticks.length === 0) return null;

  return (
    <div className="cmt-minimap" aria-hidden>
      {ticks.map(({ c, top }) => (
        <div
          key={c.id}
          className={`mm-tick ${hover === c.id ? "hot" : ""} ${c.status === "OPEN" ? "open" : "done"} ${c.author.isAI ? "ai" : ""}`}
          style={{ top }}
          onMouseEnter={() => setHover(c.id)}
          onMouseLeave={() => setHover((h) => (h === c.id ? null : h))}
          onClick={() => document.getElementById(`${idPrefix}${c.paragraphIndex}`)?.scrollIntoView({ behavior: "smooth", block: "center" })}
        >
          {hover === c.id && (
            <span className="mm-tip">
              <b>{c.author.isAI ? "🤖 " : ""}{c.aiAgentName || c.author.name}</b>
              <span className="mm-tip-meta"> · {ROLE_LABEL[c.authorRole] ?? c.authorRole} · {CATEGORY_LABEL[c.category] ?? c.category} · ¶{c.paragraphIndex + 1}</span>
              <br />{c.body.slice(0, 60)}{c.body.length > 60 ? "…" : ""}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}
