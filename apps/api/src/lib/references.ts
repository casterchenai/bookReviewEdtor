// 参考文件文本提取：PDF / Word(docx) / 表格(xlsx等) / 演示(pptx) / WPS(ooxml) / 图片
import mammoth from "mammoth";
import * as XLSX from "xlsx";
import { unzipSync, strFromU8 } from "fflate";
import { parsePdf } from "./pdf.js";

export type RefKind = "pdf" | "word" | "sheet" | "slide" | "image" | "other";

const IMG = ["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg"];
const SHEET = ["xlsx", "xls", "csv", "ods", "et"]; // .et 为 WPS 表格
const MAX_TEXT = 60_000; // 单文件提取文本上限

export async function extractReference(name: string, buf: Buffer): Promise<{ kind: RefKind; text: string }> {
  const ext = (name.split(".").pop() || "").toLowerCase();
  const isZip = buf.length > 3 && buf[0] === 0x50 && buf[1] === 0x4b; // PK..（OOXML/zip）
  const isPdf = buf.length > 3 && buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46;

  try {
    if (IMG.includes(ext)) return { kind: "image", text: "" };

    if (ext === "pdf" || isPdf) {
      const r = await parsePdf(new Uint8Array(buf));
      return { kind: "pdf", text: cap(r.text) };
    }

    // Word（docx，及 OOXML 版 WPS .wps）
    if (ext === "docx" || (isZip && ext === "wps")) {
      const r = await mammoth.extractRawText({ buffer: buf });
      if (r.value.trim()) return { kind: "word", text: cap(r.value) };
    }

    // 表格（xlsx/xls/csv/ods/et）
    if (SHEET.includes(ext)) {
      const wb = XLSX.read(buf, { type: "buffer" });
      const text = wb.SheetNames.map((n) => `【工作表：${n}】\n${XLSX.utils.sheet_to_csv(wb.Sheets[n])}`).join("\n\n");
      if (text.trim()) return { kind: "sheet", text: cap(text) };
    }

    // 演示（pptx，及 OOXML 版 WPS .dps）
    if ((ext === "pptx" || ext === "dps") && isZip) {
      const text = ooxmlSlides(buf);
      if (text.trim()) return { kind: "slide", text: cap(text) };
    }

    // 通用 OOXML 兜底（未知 zip 文档）
    if (isZip) {
      const text = ooxmlAllText(buf);
      if (text.trim()) return { kind: "other", text: cap(text) };
    }
  } catch {
    // 解析失败：仅保留文件，不提取文本
  }
  return { kind: guessKind(ext), text: "" };
}

function guessKind(ext: string): RefKind {
  if (ext === "pdf") return "pdf";
  if (["doc", "docx", "wps"].includes(ext)) return "word";
  if (SHEET.includes(ext)) return "sheet";
  if (["ppt", "pptx", "dps"].includes(ext)) return "slide";
  if (IMG.includes(ext)) return "image";
  return "other";
}

const cap = (s: string) => (s.length > MAX_TEXT ? s.slice(0, MAX_TEXT) + "\n…（文本过长已截断）" : s).trim();

// 从 pptx 的 ppt/slides/slideN.xml 提取 <a:t> 文本
function ooxmlSlides(buf: Buffer): string {
  const files = unzipSync(new Uint8Array(buf));
  const slides = Object.keys(files)
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => (parseInt(a.match(/\d+/)![0]) - parseInt(b.match(/\d+/)![0])));
  const out: string[] = [];
  slides.forEach((n, i) => {
    const xml = strFromU8(files[n]);
    const runs = [...xml.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map((m) => decodeXml(m[1]));
    if (runs.length) out.push(`【幻灯片 ${i + 1}】\n${runs.join(" ")}`);
  });
  return out.join("\n\n");
}

// 通用：抽取 zip 内所有 xml 的文本节点（兜底）
function ooxmlAllText(buf: Buffer): string {
  const files = unzipSync(new Uint8Array(buf));
  const parts: string[] = [];
  for (const n of Object.keys(files)) {
    if (!n.endsWith(".xml")) continue;
    const xml = strFromU8(files[n]);
    const runs = [...xml.matchAll(/<(?:a:t|w:t|t)>([\s\S]*?)<\/(?:a:t|w:t|t)>/g)].map((m) => decodeXml(m[1]));
    if (runs.length) parts.push(runs.join(" "));
  }
  return parts.join("\n").replace(/\s+\n/g, "\n");
}

function decodeXml(s: string): string {
  return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

// 汇总本书参考文献为一个受限文本块（供 AI 设计智能体 / 审校时核对）
export function referencesDigest(refs: { name: string; kind: string; textContent: string }[], limit = 8000): string {
  if (refs.length === 0) return "";
  const withText = refs.filter((r) => r.textContent.trim());
  const parts: string[] = [];
  const per = withText.length ? Math.max(600, Math.floor(limit / withText.length)) : 0;
  for (const r of refs) {
    if (r.textContent.trim()) parts.push(`《${r.name}》\n${r.textContent.slice(0, per)}`);
    else parts.push(`《${r.name}》（${r.kind === "image" ? "图片，未提取文字" : "未能提取文字"}）`);
  }
  return parts.join("\n\n---\n\n").slice(0, limit + 2000);
}
