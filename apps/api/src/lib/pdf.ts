// PDF 解析：逐页提取文本并分类「文本页 / 图册页」。
// 文本页 → 正文块；图册页 → 图册页标记 + 图注块（供审校/加注）。
// 仅做文本抽取与图像算子计数（不做像素渲染，无需原生依赖）。
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

export async function parsePdf(data: Uint8Array): Promise<{ doc: Doc; text: string }> {
  const pdf = await pdfjs.getDocument({
    data,
    isEvalSupported: false,
    useSystemFonts: true,
    disableFontFace: true,
  }).promise;

  const imageOps = new Set(
    ["paintImageXObject", "paintInlineImage", "paintImageMaskXObject", "paintJpegXObject", "paintImageXObjectRepeat"]
      .map((k) => pdfjs.OPS[k]).filter((v) => v !== undefined),
  );

  const blocks: Block[] = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const tc = await page.getTextContent();
    const pageText = tc.items.map((it) => it.str ?? "").join("").replace(/[ \t]+/g, " ").trim();

    let imageCount = 0;
    try {
      const ops = await page.getOperatorList();
      for (const fn of ops.fnArray) if (imageOps.has(fn)) imageCount++;
    } catch { /* 算子列表失败不影响文本 */ }

    // 分类：文本较多 → 文本页；文本很少且含图 → 图册页
    const kind: "text" | "gallery" = pageText.length >= 80 ? "text" : imageCount > 0 ? "gallery" : "text";
    blocks.push({ type: "page", pageKind: kind, label: `第 ${i} 页` });

    if (kind === "text") {
      for (const para of splitParagraphs(pageText)) blocks.push({ type: "para", text: para });
    } else {
      blocks.push({ type: "image", src: "", alt: `图册页（检测到约 ${imageCount} 张图片，可在此填写图注）` });
      if (pageText) blocks.push({ type: "note", text: pageText });
    }
  }
  if (typeof pdf.cleanup === "function") await pdf.cleanup().catch(() => {});
  if (typeof pdf.destroy === "function") await pdf.destroy().catch(() => {});
  return { doc: { blocks }, text: blocksToText(blocks) };
}

// 粗略分段：按较长的空白/句末切分，避免整页挤成一段
function splitParagraphs(text: string): string[] {
  const parts = text
    .split(/(?<=[。！？；])\s{2,}|\n{2,}/)
    .map((s) => s.trim())
    .filter(Boolean);
  return parts.length ? parts : [text];
}
