// PDF 解析：逐页提取文本并分类「文本页 / 图册页」；富解析额外用 poppler 把每页渲染为图片。
import { execFile } from "node:child_process";
import { mkdtemp, writeFile, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { blocksToText, type Block, type Doc } from "./content.js";

// pdfjs 旧版 Node 构建（不依赖 worker / canvas）
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";

interface TextItem { str?: string; hasEOL?: boolean }
interface OpList { fnArray: number[] }
type Pdfjs = {
  getDocument: (o: unknown) => { promise: Promise<PdfDoc> };
  OPS: Record<string, number>;
};
interface PdfDoc {
  numPages: number;
  getPage: (n: number) => Promise<PdfPage>;
  cleanup?: () => Promise<void>;
  destroy?: () => Promise<void>;
}
interface PdfPage {
  getTextContent: () => Promise<{ items: TextItem[] }>;
  getOperatorList: () => Promise<OpList>;
}

const pdfjs = pdfjsLib as unknown as Pdfjs;

// 逐页提取文本 + 分类（不渲染像素，无原生依赖）
export async function parsePdfPages(data: Uint8Array): Promise<{ kind: "text" | "gallery"; text: string }[]> {
  const pdf = await pdfjs.getDocument({ data, isEvalSupported: false, useSystemFonts: true, disableFontFace: true }).promise;
  const imageOps = new Set(
    ["paintImageXObject", "paintInlineImage", "paintImageMaskXObject", "paintJpegXObject", "paintImageXObjectRepeat"]
      .map((k) => pdfjs.OPS[k]).filter((v) => v !== undefined),
  );
  const pages: { kind: "text" | "gallery"; text: string }[] = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const tc = await page.getTextContent();
    const pageText = tc.items.map((it) => it.str ?? "").join("").replace(/[ \t]+/g, " ").trim();
    let imageCount = 0;
    try { const ops = await page.getOperatorList(); for (const fn of ops.fnArray) if (imageOps.has(fn)) imageCount++; } catch { /* ignore */ }
    const kind: "text" | "gallery" = pageText.length >= 80 ? "text" : imageCount > 0 ? "gallery" : "text";
    pages.push({ kind, text: pageText });
  }
  if (typeof pdf.cleanup === "function") await pdf.cleanup().catch(() => {});
  if (typeof pdf.destroy === "function") await pdf.destroy().catch(() => {});
  return pages;
}

// 文本版解析（供参考文献提取纯文本、及无 poppler 时的回退）
export async function parsePdf(data: Uint8Array): Promise<{ doc: Doc; text: string }> {
  const pages = await parsePdfPages(data);
  const blocks: Block[] = [];
  pages.forEach((p, i) => {
    blocks.push({ type: "page", pageKind: p.kind, label: `第 ${i + 1} 页` });
    if (p.kind === "text") {
      for (const para of splitParagraphs(p.text)) blocks.push({ type: "para", text: para });
    } else {
      blocks.push({ type: "image", src: "", alt: `图册页（可在此填写图注）` });
      if (p.text) blocks.push({ type: "note", text: p.text });
    }
  });
  return { doc: { blocks }, text: blocksToText(blocks) };
}

// 用 poppler(pdftoppm) 把每页渲染为 JPEG（data URI）。未安装 poppler 时抛错，由调用方降级。
export async function renderPdfToImages(buf: Buffer, opts: { scaleTo?: number; maxPages?: number } = {}): Promise<string[]> {
  const scaleTo = opts.scaleTo ?? 1200;
  const maxPages = opts.maxPages ?? 400;
  const dir = await mkdtemp(path.join(os.tmpdir(), "pdfimg-"));
  try {
    const pdfPath = path.join(dir, "in.pdf");
    await writeFile(pdfPath, buf);
    await new Promise<void>((resolve, reject) => {
      execFile("pdftoppm", ["-jpeg", "-r", "150", "-scale-to", String(scaleTo), "-l", String(maxPages), pdfPath, path.join(dir, "p")],
        { timeout: 180000, maxBuffer: 1024 * 1024 }, (err) => (err ? reject(err) : resolve()));
    });
    const files = (await readdir(dir)).filter((f) => /\.jpg$/i.test(f)).sort(naturalCmp);
    const out: string[] = [];
    for (const f of files) {
      const b = await readFile(path.join(dir, f));
      out.push(`data:image/jpeg;base64,${b.toString("base64")}`);
    }
    return out;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

function naturalCmp(a: string, b: string) {
  const na = parseInt(a.match(/(\d+)\.jpg$/i)?.[1] ?? "0", 10);
  const nb = parseInt(b.match(/(\d+)\.jpg$/i)?.[1] ?? "0", 10);
  return na - nb;
}

// 富解析：每页 = 页标记 + 渲染图（若可）+ 可评审文字。适合图文杂志类 PDF。
export async function parsePdfRich(buf: Buffer): Promise<{ doc: Doc; text: string; rendered: boolean }> {
  const pages = await parsePdfPages(new Uint8Array(buf));
  let images: string[] = [];
  try { images = await renderPdfToImages(buf); } catch { images = []; }
  const blocks: Block[] = [];
  pages.forEach((p, i) => {
    blocks.push({ type: "page", pageKind: p.kind, label: `第 ${i + 1} 页` });
    if (images[i]) blocks.push({ type: "image", src: images[i], alt: `第 ${i + 1} 页` });
    for (const para of splitParagraphs(p.text)) if (para.trim()) blocks.push({ type: "para", text: para });
    if (!p.text.trim() && !images[i]) blocks.push({ type: "note", text: "（本页无可提取文字，且未渲染图片）" });
  });
  return { doc: { blocks }, text: blocksToText(blocks), rendered: images.length > 0 };
}

// 粗略分段：按较长的空白/句末切分，避免整页挤成一段
function splitParagraphs(text: string): string[] {
  const parts = text
    .split(/(?<=[。！？；])\s{2,}|\n{2,}/)
    .map((s) => s.trim())
    .filter(Boolean);
  return parts.length ? parts : [text];
}
