// 图片文字识别（OCR）：调用系统 tesseract（chi_sim+eng）。未安装时抛错，由调用方降级。
import { execFile } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Block } from "./content.js";

function dataUriToBuffer(s: string): Buffer {
  const m = s.match(/^data:[^;,]+;base64,(.*)$/s);
  return Buffer.from(m ? m[1] : s, "base64");
}

// 对单张图片（data URI 或 Buffer）做 OCR，返回识别到的文字（可能为空）。
export async function ocrImage(image: string | Buffer, opts: { lang?: string } = {}): Promise<string> {
  const lang = opts.lang ?? "chi_sim+eng";
  const buf = typeof image === "string" ? dataUriToBuffer(image) : image;
  if (!buf.length) return "";
  const dir = await mkdtemp(path.join(os.tmpdir(), "ocr-"));
  try {
    const img = path.join(dir, "in.png");
    await writeFile(img, buf);
    const text = await new Promise<string>((resolve, reject) => {
      execFile("tesseract", [img, "stdout", "-l", lang, "--psm", "3"],
        { timeout: 120000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
    });
    // tesseract 中文常在字间插空格，去掉「汉字 汉字」间的空格，保留英文/数字间空格
    return text
      .replace(/[ \t]+/g, " ")
      .replace(/([一-鿿]) (?=[一-鿿])/g, "$1")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

// 对文档中的「页面块」（image + page）逐页 OCR，识别结果写入 block.ocr（隐藏，不改动图片本身）。
// blockIndex 指定则只识别该页；force 为真则重识别已有结果的页。
export async function ocrPageBlocks(
  blocks: Block[],
  opts: { blockIndex?: number; force?: boolean } = {},
): Promise<{ blocks: Block[]; updated: number; scanned: number }> {
  const next = blocks.slice();
  let updated = 0, scanned = 0;
  for (let i = 0; i < next.length; i++) {
    if (opts.blockIndex !== undefined && i !== opts.blockIndex) continue;
    const b = next[i];
    if (b.type !== "image" || !b.page || !b.src) continue;
    scanned++;
    if (!opts.force && (b.ocr ?? "").trim().length > 0) continue;
    try {
      const text = await ocrImage(b.src);
      next[i] = { ...b, ocr: text };
      updated++;
    } catch (err) {
      console.error(`OCR failed on page ${b.page}:`, err);
    }
  }
  return { blocks: next, updated, scanned };
}

let cachedAvail: boolean | null = null;
export async function isOcrAvailable(): Promise<boolean> {
  if (cachedAvail !== null) return cachedAvail;
  cachedAvail = await new Promise<boolean>((resolve) => {
    execFile("tesseract", ["--version"], { timeout: 8000 }, (err) => resolve(!err));
  });
  return cachedAvail;
}
