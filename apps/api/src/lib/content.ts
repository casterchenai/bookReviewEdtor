// 结构化块内容：HTML / Markdown → 块数组（标题/正文/注记/列表/表格/图片），并生成纯文本投影。
// 纯文本投影用于 AI 审校、版本对比与搜索；块用于富内容审校与渲染。
import * as cheerio from "cheerio";
import { marked } from "marked";
import type { AnyNode } from "domhandler";

export type Block =
  | { type: "heading"; level: number; text: string }
  | { type: "para"; text: string }
  | { type: "note"; text: string }
  | { type: "list"; ordered: boolean; items: string[] }
  | { type: "table"; rows: { cells: string[]; header: boolean }[] }
  | { type: "image"; src: string; alt: string }
  | { type: "page"; pageKind: "text" | "gallery"; label: string };

export interface Doc {
  blocks: Block[];
}

const MAX_IMG_BYTES = 3_000_000; // 内嵌图片（data URI）大小上限，超出则丢弃 src 仅留占位

// ===== HTML → 块 =====
export function parseHtml(html: string): { doc: Doc; text: string } {
  const $ = cheerio.load(html);
  const blocks: Block[] = [];
  const body = $("body");
  const topEls: AnyNode[] = body.length ? body.children().toArray() : $.root().children().toArray();

  for (const el of topEls) walk($, el, blocks);
  // 若未产出任何块（例如没有 body 包裹），退化为整体文本
  if (blocks.length === 0) {
    const t = $.root().text().trim();
    if (t) blocks.push({ type: "para", text: t });
  }
  return { doc: { blocks }, text: blocksToText(blocks) };
}

function walk($: cheerio.CheerioAPI, el: AnyNode, out: Block[]) {
  if (el.type !== "tag") return;
  const tag = el.tagName?.toLowerCase();
  const node = $(el);

  switch (tag) {
    case "h1": case "h2": case "h3": case "h4": case "h5": case "h6": {
      const text = clean(node.text());
      if (text) out.push({ type: "heading", level: Number(tag[1]), text });
      break;
    }
    case "p": {
      const text = clean(node.text());
      if (text) out.push({ type: "para", text });
      break;
    }
    case "ul": case "ol": {
      const items = node.children("li").map((_, li) => clean($(li).text())).get().filter(Boolean);
      if (items.length) out.push({ type: "list", ordered: tag === "ol", items });
      break;
    }
    case "table": {
      const rows: { cells: string[]; header: boolean }[] = [];
      node.find("tr").each((_, tr) => {
        const $tr = $(tr);
        const cellEls = $tr.children("th,td");
        const header = cellEls.length > 0 && cellEls.get().every((c) => (c as { tagName?: string }).tagName?.toLowerCase() === "th");
        const cells = cellEls.map((_, c) => clean($(c).text())).get();
        if (cells.length) rows.push({ cells, header });
      });
      if (rows.length) out.push({ type: "table", rows });
      break;
    }
    case "img": {
      pushImage(node.attr("src") || "", node.attr("alt") || "", out);
      break;
    }
    case "figure": {
      const img = node.find("img").first();
      if (img.length) pushImage(img.attr("src") || "", img.attr("alt") || node.find("figcaption").text() || "", out);
      break;
    }
    case "blockquote": {
      const text = clean(node.text());
      if (text) out.push({ type: "note", text });
      break;
    }
    case "div": case "section": case "article": {
      const cls = node.attr("class") || "";
      if (/note|callout|tip|warning|remark/i.test(cls)) {
        const text = clean(node.text());
        if (text) out.push({ type: "note", text });
      } else {
        node.children().each((_, c) => walk($, c, out)); // 递归容器
      }
      break;
    }
    default: {
      // 其他标签：递归其子节点
      node.children().each((_, c) => walk($, c, out));
    }
  }
}

function pushImage(src: string, alt: string, out: Block[]) {
  if (src.startsWith("data:") && src.length > MAX_IMG_BYTES) {
    out.push({ type: "image", src: "", alt: alt || "（图片过大，已省略）" });
  } else {
    out.push({ type: "image", src, alt: clean(alt) });
  }
}

function clean(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

// ===== Markdown → 块（复用 HTML 解析）=====
export function parseMarkdown(md: string): { doc: Doc; text: string } {
  const html = marked.parse(md, { async: false }) as string;
  return parseHtml(html);
}

// ===== 块 → 纯文本投影 =====
export function blocksToText(blocks: Block[]): string {
  const parts: string[] = [];
  for (const b of blocks) {
    switch (b.type) {
      case "heading": parts.push(b.text); break;
      case "para": parts.push(b.text); break;
      case "note": parts.push(b.text); break;
      case "list": parts.push(b.items.map((i) => `· ${i}`).join("\n")); break;
      case "table": parts.push(b.rows.map((r) => r.cells.join(" | ")).join("\n")); break;
      case "image": parts.push(b.alt ? `［图片：${b.alt}］` : "［图片］"); break;
      case "page": parts.push(`【${b.label}·${b.pageKind === "gallery" ? "图册页" : "文本页"}】`); break;
    }
  }
  return parts.join("\n\n");
}

// ===== 校验/规范化外部传入的 docJson =====
export function normalizeDoc(raw: unknown): Doc | null {
  if (!raw || typeof raw !== "object") return null;
  const blocks = (raw as { blocks?: unknown }).blocks;
  if (!Array.isArray(blocks)) return null;
  const ok: Block[] = [];
  for (const b of blocks) {
    if (!b || typeof b !== "object" || typeof (b as { type?: unknown }).type !== "string") continue;
    ok.push(b as Block);
  }
  return { blocks: ok };
}

// 取某个块的可编辑主文本（用于建议采纳/编辑）
export function blockText(b: Block): string {
  if (b.type === "heading" || b.type === "para" || b.type === "note") return b.text;
  if (b.type === "list") return b.items.join("\n");
  if (b.type === "table") return b.rows.map((r) => r.cells.join("\t")).join("\n");
  if (b.type === "image") return b.alt;
  return "";
}

// 用新文本替换某个块的主文本，返回新块
export function setBlockText(b: Block, text: string): Block {
  if (b.type === "heading" || b.type === "para" || b.type === "note") return { ...b, text };
  if (b.type === "list") return { ...b, items: text.split("\n").map((s) => s.trim()).filter(Boolean) };
  if (b.type === "table") {
    const rows = text.split("\n").map((line, i) => ({ cells: line.split("\t"), header: b.rows[i]?.header ?? false }));
    return { ...b, rows };
  }
  if (b.type === "image") return { ...b, alt: text };
  return b;
}
