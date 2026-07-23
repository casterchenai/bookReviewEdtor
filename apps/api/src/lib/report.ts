// 审校报告：把书稿的审校意见按「页 / 段落」汇总，供排版设计师据此修改 PDF。
import type { Block, Mark } from "./content.js";

export interface ReportComment {
  paragraphIndex: number;
  quote: string;
  body: string;
  category: string;
  suggestedText: string | null;
  aiAgentName: string | null;
  authorRole: string;
  authorName: string;
  status: string;
}

export interface ReportMark {
  kind: string;      // rect / pen / text
  color: string;
  by?: string;
  text?: string;     // 仅文字批注有
}

export interface ReportGroup {
  page: string;          // 页标签，如「第 3 页」；无分页信息时为「正文」
  pageKind?: string;     // text / gallery / page
  marks: ReportMark[];   // 该页上的持久批注
  items: (ReportComment & { blockText: string })[];
}

const CATEGORY_LABEL: Record<string, string> = {
  GENERAL: "一般意见", GRAMMAR: "语法纠错", WORDING: "用词优化", LOGIC: "逻辑问题",
  STYLE: "表达风格", MARKET: "市场适配", STANDARD: "内容规范",
};
export function categoryLabel(c: string) { return CATEGORY_LABEL[c] ?? c; }

const STATUS_LABEL: Record<string, string> = {
  OPEN: "待处理", RESOLVED: "已解决", ACCEPTED: "建议已采纳", REJECTED: "建议已驳回",
};
export function statusLabel(s: string) { return STATUS_LABEL[s] ?? s; }

interface PageInfo { label: string; kind?: string; marks: Mark[] }

// 为每个块序号计算所属「页」；PDF 现在是一页一块（image + page），旧格式的 page 标记块也兼容。
function pageIndex(blocks: Block[] | null): {
  pageOf: (i: number) => PageInfo;
  textOf: (i: number) => string;
  pages: PageInfo[];
} {
  const fallback: PageInfo = { label: "正文", marks: [] };
  if (!blocks) return { pageOf: () => fallback, textOf: () => "", pages: [fallback] };

  const map: PageInfo[] = [];
  const pages: PageInfo[] = [];
  let cur: PageInfo = fallback;
  blocks.forEach((b, i) => {
    if (b.type === "image" && b.page) {
      cur = { label: b.alt || `第 ${b.page} 页`, kind: "page", marks: b.marks ?? [] };
    } else if (b.type === "page") {
      cur = { label: b.label, kind: b.pageKind, marks: [] }; // 兼容旧解析格式
    }
    map[i] = cur;
    if (!pages.includes(cur)) pages.push(cur);
  });
  if (!pages.length) pages.push(fallback);

  const textOf = (i: number) => {
    const b = blocks[i];
    if (!b) return "";
    switch (b.type) {
      case "heading": case "para": case "note": return b.text;
      case "list": return b.items.join("；");
      case "table": return b.rows.map((r) => r.cells.join(" | ")).join(" / ");
      // 页面块：引用隐藏的识别文字，便于排版定位；普通图片用图注
      case "image": return b.page ? (b.ocr ?? "").trim() : `［图片：${b.alt || "无说明"}］`;
      case "page": return "";
    }
  };
  return { pageOf: (i) => map[i] ?? cur, textOf, pages };
}

function toReportMark(m: Mark): ReportMark {
  return { kind: m.kind, color: m.color, by: m.by, text: m.kind === "text" ? m.text : undefined };
}

// 汇总：按页（文档顺序）分组，组内按段落序号排序。
// 只有批注、没有文字意见的页也会列出，便于排版按标注修改。
export function buildReport(blocks: Block[] | null, comments: ReportComment[]): ReportGroup[] {
  const { pageOf, textOf, pages } = pageIndex(blocks);
  const byPage = new Map<PageInfo, (ReportComment & { blockText: string })[]>();
  const sorted = [...comments].sort((a, b) => a.paragraphIndex - b.paragraphIndex);
  for (const c of sorted) {
    const p = pageOf(c.paragraphIndex);
    if (!byPage.has(p)) byPage.set(p, []);
    byPage.get(p)!.push({ ...c, blockText: c.quote || textOf(c.paragraphIndex) });
  }
  const out: ReportGroup[] = [];
  for (const p of pages) {
    const items = byPage.get(p) ?? [];
    if (!items.length && !p.marks.length) continue;
    out.push({ page: p.label, pageKind: p.kind, marks: p.marks.map(toReportMark), items });
  }
  return out;
}

function esc(s: string) {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
}

// HTML 报告（可打印 / 预览）
export function reviewReportHtml(
  title: string,
  groups: ReportGroup[],
  roleLabel: (r: string) => string,
): string {
  const total = groups.reduce((n, g) => n + g.items.length, 0);
  const date = new Date().toLocaleString("zh-CN", { hour12: false });
  const rows = groups.map((g) => {
    const body = g.items.map((c, i) => {
      const who = c.aiAgentName ? `${esc(c.aiAgentName)}（AI）` : `${esc(c.authorName)}（${esc(roleLabel(c.authorRole))}）`;
      const sug = c.suggestedText ? `<div class="sug"><b>建议改为：</b>${esc(c.suggestedText)}</div>` : "";
      const quote = c.blockText ? `<div class="quote">${esc(c.blockText.slice(0, 300))}</div>` : "";
      return `<tr>
        <td class="idx">¶${c.paragraphIndex + 1}</td>
        <td class="cat"><span class="tag">${esc(categoryLabel(c.category))}</span></td>
        <td class="cnt">${quote}<div class="body">${esc(c.body)}</div>${sug}</td>
        <td class="who">${who}<div class="st">${esc(statusLabel(c.status))}</div></td>
      </tr>`;
    }).join("");
    const kind = g.pageKind === "gallery" ? " · 图册页" : g.pageKind === "text" ? " · 文本页" : "";
    const marksBlock = g.marks.length ? `<div class="marks"><b>页面批注 ${g.marks.length} 处：</b>${
      g.marks.map((m) => {
        const who = m.by ? `（${esc(m.by)}）` : "";
        const label = m.kind === "text" ? `文字「${esc(m.text || "")}」` : m.kind === "rect" ? "框选" : "涂鸦";
        return `<span class="mk" style="border-color:${esc(m.color)}">${label}${who}</span>`;
      }).join(" ")
    }</div>` : "";
    const table = g.items.length
      ? `<table class="rep"><thead><tr><th>位置</th><th>类别</th><th>审校意见 / 修改建议</th><th>审校人</th></tr></thead><tbody>${body}</tbody></table>`
      : `<p class="nocmt">本页无文字意见，仅有图上批注。</p>`;
    return `<h2 class="pg">${esc(g.page)}${kind}<span class="cn">${g.items.length} 条意见${g.marks.length ? ` · ${g.marks.length} 处批注` : ""}</span></h2>
      ${marksBlock}${table}`;
  }).join("\n");

  return `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · 审校报告</title>
<style>
  body { font-family: -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; color: #1a1a1a; max-width: 960px; margin: 0 auto; padding: 32px 20px; line-height: 1.6; }
  h1 { font-size: 1.6rem; margin: 0 0 4px; }
  .meta { color: #666; font-size: 0.9rem; margin-bottom: 24px; }
  .pg { font-size: 1.15rem; margin: 28px 0 8px; padding-bottom: 6px; border-bottom: 2px solid #d0d0d0; display: flex; align-items: baseline; gap: 10px; }
  .pg .cn { font-size: 0.8rem; color: #888; font-weight: normal; }
  table.rep { width: 100%; border-collapse: collapse; margin-bottom: 8px; }
  table.rep th, table.rep td { border: 1px solid #ddd; padding: 8px 10px; vertical-align: top; text-align: left; font-size: 0.92rem; }
  table.rep th { background: #f5f5f5; font-weight: 600; }
  td.idx { white-space: nowrap; color: #888; font-variant-numeric: tabular-nums; width: 3.4em; }
  td.cat { width: 4.5em; }
  .tag { display: inline-block; background: #eef2ff; color: #3949ab; border-radius: 4px; padding: 1px 7px; font-size: 0.8rem; }
  td.who { white-space: nowrap; color: #444; width: 9em; }
  .who .st { color: #999; font-size: 0.78rem; margin-top: 2px; }
  .quote { background: #fafafa; border-left: 3px solid #ccc; padding: 4px 8px; color: #555; font-size: 0.85rem; margin-bottom: 6px; }
  .body { white-space: pre-wrap; }
  .sug { margin-top: 6px; background: #f0fbf3; border-left: 3px solid #4caf50; padding: 4px 8px; font-size: 0.88rem; }
  .marks { margin: 6px 0 10px; font-size: 0.88rem; color: #444; }
  .mk { display: inline-block; border: 2px solid #999; border-radius: 4px; padding: 1px 7px; margin: 2px 4px 2px 0; background: #fff; }
  .nocmt { color: #999; font-size: 0.9rem; margin: 4px 0 12px; }
  @media print { .pg { break-after: avoid; } tr { break-inside: avoid; } }
</style></head><body>
<h1>${esc(title)} · 审校报告</h1>
<div class="meta">共 ${total} 条审校意见 · 生成于 ${esc(date)}${groups.length ? ` · 涉及 ${groups.length} 个位置分组` : ""}</div>
${total ? rows : '<p style="color:#999">暂无审校意见。</p>'}
</body></html>`;
}
